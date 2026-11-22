import { randomUUID } from "crypto";
import { Meeting } from "../models/meeting.js";
import { MeetingSession } from "../models/meetingSession.js";
import { Transcript } from "../models/transcript.js";
import { encryptSessionTitle, setSessionAutoTitle } from "../services/meetingSessionService.js";
import { encryptMeetingTitle } from "../services/meetingService.js";
import { createSoapNote } from "../services/soapNoteService.js";
import { generateSoaps, generateVisitTitle } from "../services/soapsService.js";
import { indexInBackground, indexSessionArtifacts } from "../services/knowledgeIndexService.js";
import { getUserEntitlements } from "../services/entitlementService.js";
import {
  isAcceptedRecordingType,
  isRecordingTranscriptionConfigured,
  transcribeRecording,
} from "../services/recordingIngestService.js";
import { encryptField } from "../utils/fieldCipher.js";
import { TRANSCRIPT_TEXT_CONTEXT } from "../services/transcriptService.js";
import { resolveLanguage, resolveNoteLanguage } from "../utils/languages.js";
import { sendErrorResponse } from "../utils/errors.js";
import { logError } from "../utils/logging.js";

export const FREE_UPLOAD_LIMIT = 3;
const KINDS = new Set(["voice_visit", "upload"]);

function headerValue(req, name) {
  const value = req.headers?.[name];
  return typeof value === "string" ? value.trim() : "";
}

// Deleted uploads still count, so the free allowance cannot be reset by
// deleting a visit and uploading again.
async function countUploads(userId) {
  return Meeting.countDocuments({ createdBy: userId, source: "upload" }).setOptions({ includeDeleted: true });
}

export async function getRecordingQuota(req, res) {
  try {
    const entitlements = await getUserEntitlements(req.user?._id);
    const used = await countUploads(req.user?._id);
    res.json({
      configured: isRecordingTranscriptionConfigured(),
      paid: Boolean(entitlements?.paid),
      uploadsUsed: used,
      uploadLimit: entitlements?.paid ? null : FREE_UPLOAD_LIMIT,
      uploadsRemaining: entitlements?.paid ? null : Math.max(0, FREE_UPLOAD_LIMIT - used),
    });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to load upload status", status: 500, event: "recording.quota_failed" });
  }
}

// One pipeline for both entry points: a voice visit recorded in the browser and
// a file the provider uploads arrive here the same way.
export async function ingestRecording(req, res) {
  const kind = KINDS.has(headerValue(req, "x-recording-kind")) ? headerValue(req, "x-recording-kind") : "upload";
  try {
    if (!isRecordingTranscriptionConfigured()) {
      res.status(503).json({ error: "Transcription is not configured on this server" });
      return;
    }

    const contentType = String(req.headers?.["content-type"] || "");
    if (!isAcceptedRecordingType(contentType)) {
      res.status(415).json({ error: "That file type is not supported" });
      return;
    }

    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer?.length) {
      res.status(400).json({ error: "The recording is empty" });
      return;
    }

    if (kind === "upload") {
      const entitlements = await getUserEntitlements(req.user?._id);
      if (!entitlements?.paid) {
        const used = await countUploads(req.user?._id);
        if (used >= FREE_UPLOAD_LIMIT) {
          res.status(402).json({
            error: `Free accounts can upload ${FREE_UPLOAD_LIMIT} recordings. Upgrade for unlimited uploads.`,
            code: "upload_limit_reached",
          });
          return;
        }
      }
    }

    const selectedLanguage = resolveLanguage(headerValue(req, "x-recording-language"));
    const transcription = await transcribeRecording(buffer, {
      mimeType: contentType,
      language: selectedLanguage,
    });

    if (!transcription.text) {
      res.status(422).json({ error: "No speech was found in that recording" });
      return;
    }

    const language = resolveNoteLanguage({ selected: selectedLanguage, detected: transcription.language });
    const providedTitle = headerValue(req, "x-recording-title").slice(0, 120);
    const startedAt = new Date(Date.now() - transcription.durationSeconds * 1000);
    const roomId = `rec-${randomUUID()}`;

    const meeting = await Meeting.create({
      roomId,
      title: providedTitle ? encryptMeetingTitle(providedTitle) : undefined,
      createdBy: req.user?._id,
      source: kind,
      transcriptLanguage: selectedLanguage,
      startedAt,
      endedAt: new Date(),
      sessionsCount: 1,
      currentSessionIndex: 1,
    });

    const session = await MeetingSession.create({
      meetingId: meeting._id,
      roomId,
      title: providedTitle ? encryptSessionTitle(providedTitle) : undefined,
      sessionIndex: 1,
      startedAt,
      endedAt: new Date(),
      createdBy: req.user?._id,
    });

    await Transcript.create({
      roomId,
      peerId: kind === "voice_visit" ? "voice-visit" : "upload",
      sessionIndex: 1,
      meetingSessionId: session._id,
      language: transcription.language || undefined,
      text: encryptField(transcription.text, TRANSCRIPT_TEXT_CONTEXT),
    });

    const content = await generateSoaps(transcription.text, { language });
    let note = null;
    if (content) {
      note = await createSoapNote({
        roomId,
        content,
        meetingId: meeting._id,
        meetingSessionId: session._id,
        sessionIndex: 1,
        createdBy: req.user?._id,
        language,
      });
    }

    const autoTitle = await generateVisitTitle(transcription.text, { language });
    if (autoTitle) {
      await setSessionAutoTitle(session._id, autoTitle).catch((err) =>
        logError("recording.title_failed", err)
      );
    }

    indexInBackground(
      () => indexSessionArtifacts({ roomId, sessionIndex: 1, meetingSessionId: session._id, soapNoteId: note?._id }),
      "recording"
    );

    // The audio itself was never stored; only the transcript and note remain.
    res.json({
      sessionId: session._id,
      meetingId: meeting._id,
      title: autoTitle || providedTitle || "",
      language,
      durationSeconds: transcription.durationSeconds,
      note,
    });
  } catch (err) {
    sendErrorResponse(res, err, {
      fallback: "Failed to process that recording",
      status: 400,
      event: `recording.${kind}_failed`,
    });
  }
}
