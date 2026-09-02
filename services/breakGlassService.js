import { BreakGlassGrant } from "../models/breakGlassGrant.js";
import { User } from "../models/user.js";
import { Meeting } from "../models/meeting.js";
import { MeetingSession } from "../models/meetingSession.js";
import { Transcript } from "../models/transcript.js";
import { SoapNote } from "../models/soapNote.js";
import { PrivateNote } from "../models/privateNote.js";
import { publicError } from "../utils/errors.js";
import { logError } from "../utils/logging.js";
import { sendBreakGlassAlertEmail } from "../utils/mailer.js";
import { verifyMfaChallenge } from "./userService.js";
import { decryptMeeting } from "./meetingService.js";
import { decryptSession } from "./meetingSessionService.js";
import { decryptFieldOrNull } from "../utils/fieldCipher.js";
import { sanitizeSoapContent } from "../utils/clinicalHtml.js";

const GRANT_TTL_MS = 60 * 60 * 1000;
const MIN_REASON_LENGTH = 20;

export function isGrantActive(grant, now = Date.now()) {
  if (!grant || grant.revokedAt) return false;
  return new Date(grant.expiresAt).getTime() > now;
}

// A reviewer has only this to judge the access by.
function normalizeReason(reason) {
  const value = String(reason || "").trim();
  if (value.length < MIN_REASON_LENGTH) {
    throw publicError(`Give a reason of at least ${MIN_REASON_LENGTH} characters for this emergency access`);
  }
  return value.slice(0, 1000);
}

export async function createBreakGlassGrant({ actor, targetUserId, reason, code, ipAddress }) {
  const justification = normalizeReason(reason);
  if (String(actor?._id) === String(targetUserId)) {
    throw publicError("Use your own account normally; emergency access is for other users' records");
  }

  const target = await User.findById(targetUserId).lean();
  if (!target) throw publicError("User not found", 404);

  // Step-up:
  await verifyMfaChallenge(actor?._id, code);

  const grant = await BreakGlassGrant.create({
    grantedTo: actor._id,
    grantedToEmail: actor.email,
    targetUserId: target._id,
    targetEmail: target.email,
    reason: justification,
    expiresAt: new Date(Date.now() + GRANT_TTL_MS),
    ipAddress,
  });

  const notified = await notifyOtherAdmins(grant, actor);
  if (notified) await BreakGlassGrant.updateOne({ _id: grant._id }, { $set: { notifiedAdminCount: notified } });

  return { ...grant.toObject(), notifiedAdminCount: notified };
}

// Peer notification is what makes this "break glass":
async function notifyOtherAdmins(grant, actor) {
  try {
    const admins = await User.find({
      role: "admin",
      status: { $ne: "deactivated" },
      _id: { $ne: actor._id },
    })
      .select("email")
      .lean();
    await Promise.all(
      admins.map((admin) =>
        sendBreakGlassAlertEmail({
          email: admin.email,
          actorEmail: actor.email,
          targetEmail: grant.targetEmail,
          reason: grant.reason,
          expiresAt: grant.expiresAt,
        }).catch((err) => logError("breakglass.notify_failed", err))
      )
    );
    return admins.length;
  } catch (err) {
    logError("breakglass.notify_failed", err);
    return 0;
  }
}

export async function revokeBreakGlassGrant(grantId, actorId) {
  const grant = await BreakGlassGrant.findById(grantId);
  if (!grant) throw publicError("Grant not found", 404);
  if (grant.revokedAt) return grant.toObject();
  grant.revokedAt = new Date();
  await grant.save();
  return grant.toObject();
}

export async function listBreakGlassGrants({ limit = 50 } = {}) {
  const grants = await BreakGlassGrant.find({}).sort({ createdAt: -1 }).limit(limit).lean();
  return grants.map((grant) => ({ ...grant, active: isGrantActive(grant) }));
}

export async function getActiveGrant(grantId, actorId) {
  const grant = await BreakGlassGrant.findById(grantId).lean();
  if (!grant) throw publicError("Grant not found", 404);
  if (String(grant.grantedTo) !== String(actorId)) {
    throw publicError("This emergency access grant belongs to another administrator", 403);
  }
  if (!isGrantActive(grant)) throw publicError("This emergency access grant has expired", 403);
  return grant;
}

// Includes soft-deleted records; reaching those is the point.
export async function readRecordsUnderGrant(grantId, actorId) {
  const grant = await getActiveGrant(grantId, actorId);
  const withDeleted = { includeDeleted: true };

  const meetings = await Meeting.find({ createdBy: grant.targetUserId })
    .setOptions(withDeleted)
    .sort({ createdAt: -1 })
    .lean();
  const meetingIds = meetings.map((meeting) => meeting._id);
  const roomIds = meetings.map((meeting) => meeting.roomId);

  const [sessions, soapNotes, privateNotes, transcripts] = await Promise.all([
    MeetingSession.find({ meetingId: { $in: meetingIds } }).setOptions(withDeleted).lean(),
    SoapNote.find({ $or: [{ meetingId: { $in: meetingIds } }, { roomId: { $in: roomIds } }] })
      .setOptions(withDeleted)
      .lean(),
    PrivateNote.find({ meetingId: { $in: meetingIds } }).setOptions(withDeleted).lean(),
    Transcript.find({ roomId: { $in: roomIds } }).setOptions(withDeleted).lean(),
  ]);

  await BreakGlassGrant.updateOne(
    { _id: grant._id },
    { $inc: { accessCount: 1 }, $set: { lastAccessedAt: new Date() } }
  );

  return {
    grant: { ...grant, active: true },
    target: { id: String(grant.targetUserId), email: grant.targetEmail },
    retrievedAt: new Date(),
    meetings: meetings.map((meeting) => ({ ...decryptMeeting(meeting), deleted: Boolean(meeting.deletedAt) })),
    sessions: sessions.map((session) => ({ ...decryptSession(session), deleted: Boolean(session.deletedAt) })),
    soapNotes: soapNotes.map((note) => ({
      ...note,
      content: sanitizeSoapContent(
        Object.fromEntries(
          Object.entries(note.content || {}).map(([key, value]) => [
            key,
            typeof value === "string" ? decryptFieldOrNull(value, `SoapNote.content.${key}`) ?? "" : value,
          ])
        )
      ),
      summary: note.summary ? decryptFieldOrNull(note.summary, "SoapNote.summary") ?? "" : "",
      deleted: Boolean(note.deletedAt),
    })),
    privateNotes: privateNotes.map((note) => ({
      ...note,
      content: decryptFieldOrNull(note.content, "PrivateNote.content") ?? "",
      deleted: Boolean(note.deletedAt),
    })),
    transcripts: transcripts.map((entry) => ({
      ...entry,
      text: decryptFieldOrNull(entry.text, "Transcript.text") ?? "",
      deleted: Boolean(entry.deletedAt),
    })),
  };
}
