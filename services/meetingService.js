import { randomUUID } from "crypto";
import { Meeting } from "../models/meeting.js";
import { User } from "../models/user.js";
import { decryptFieldOrNull, encryptField } from "../utils/fieldCipher.js";

const SAFE_CREATOR_FIELDS = "_id firstName lastName displayName email";

// Titles and descriptions carry patient names, so treated as PHI.
export const MEETING_TITLE_CONTEXT = "Meeting.title";
export const MEETING_DESCRIPTION_CONTEXT = "Meeting.description";

export function decryptMeeting(meeting) {
  if (!meeting) return meeting;
  const plain = typeof meeting.toObject === "function" ? meeting.toObject() : { ...meeting };
  if (plain.title) plain.title = decryptFieldOrNull(plain.title, MEETING_TITLE_CONTEXT) ?? "";
  if (plain.description) {
    plain.description = decryptFieldOrNull(plain.description, MEETING_DESCRIPTION_CONTEXT) ?? "";
  }
  return plain;
}

export function encryptMeetingTitle(title) {
  return title ? encryptField(title, MEETING_TITLE_CONTEXT) : title;
}

export function encryptMeetingDescription(description) {
  return description ? encryptField(description, MEETING_DESCRIPTION_CONTEXT) : description;
}

export async function upsertMeeting({ roomId, creatorPeerId, creatorSocketId }) {
  if (!roomId) return null;
  const now = new Date();
  const meeting = await Meeting.findOneAndUpdate(
    { roomId },
    {
      $setOnInsert: { roomId, startedAt: now, sessionsCount: 0 },
      $set: { creatorPeerId, creatorSocketId },
    },
    { new: true, upsert: true }
  );
  if (!meeting.startedAt) {
    meeting.startedAt = now;
    await meeting.save();
  }
  return decryptMeeting(meeting);
}

export async function endMeeting(roomId) {
  if (!roomId) return null;
  return decryptMeeting(
    await Meeting.findOneAndUpdate({ roomId }, { endedAt: new Date() }, { new: true })
  );
}

export async function listMeetings() {
  const meetings = await Meeting.find({}).sort({ createdAt: -1 }).lean();
  return meetings.map(decryptMeeting);
}

export async function getMeeting(roomId) {
  if (!roomId) return null;
  return decryptMeeting(await Meeting.findOne({ roomId }).lean());
}

export async function createScheduledMeeting({ title, description, scheduledFor, createdBy }) {
  const roomId = randomUUID();
  const scheduled = scheduledFor ? new Date(scheduledFor) : null;
  const validDate = scheduled && !Number.isNaN(scheduled.getTime()) ? scheduled : null;
  const meeting = await Meeting.create({
    roomId,
    title: encryptMeetingTitle(title || "Untitled meeting"),
    description: encryptMeetingDescription(description),
    scheduledFor: validDate,
    createdBy,
  });
  return decryptMeeting(meeting.toObject());
}

export async function listMeetingsForUser(userId, includeAll = false) {
  const filter = includeAll ? {} : { createdBy: userId };
  const meetings = await Meeting.find(filter).sort({ createdAt: -1 }).lean();
  return meetings.map(decryptMeeting);
}

export async function getMeetingById(id) {
  if (!id) return null;
  return decryptMeeting(await Meeting.findById(id).lean());
}

export async function listMeetingsWithCreators(userId, includeAll = false) {
  const filter = includeAll ? {} : { createdBy: userId };
  const meetings = await Meeting.find(filter).sort({ createdAt: -1 }).lean();
  const creatorIds = meetings.map((m) => m.createdBy).filter(Boolean);
  const creators = await User.find({ _id: { $in: creatorIds } }).select(SAFE_CREATOR_FIELDS).lean();
  const map = new Map(creators.map((u) => [String(u._id), u]));
  return meetings.map((m) => ({
    ...decryptMeeting(m),
    creator: m.createdBy ? map.get(String(m.createdBy)) : null,
  }));
}

export async function getMeetingWithCreator(id) {
  if (!id) return null;
  const meeting = await Meeting.findById(id).lean();
  if (!meeting) return null;
  const creator = meeting.createdBy
    ? await User.findById(meeting.createdBy).select(SAFE_CREATOR_FIELDS).lean()
    : null;
  return { ...decryptMeeting(meeting), creator };
}
