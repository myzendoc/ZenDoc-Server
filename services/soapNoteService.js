import { SoapNote } from "../models/soapNote.js";
import { sanitizeClinicalHtml, sanitizeSoapContent, sanitizeSoapNote } from "../utils/clinicalHtml.js";
import { decryptFieldOrNull, decryptValues, encryptField, encryptValues } from "../utils/fieldCipher.js";
import { logError } from "../utils/logging.js";

// Sections encrypted individually so one can be updated alone.
export const SOAP_CONTENT_CONTEXT = "SoapNote.content";
export const SOAP_SUMMARY_CONTEXT = "SoapNote.summary";

function decryptNote(note) {
  if (!note) return null;
  const plain = typeof note.toObject === "function" ? note.toObject() : { ...note };
  plain.content = decryptValues(plain.content, SOAP_CONTENT_CONTEXT);
  if (plain.summary) {
    const summary = decryptFieldOrNull(plain.summary, SOAP_SUMMARY_CONTEXT);
    if (summary === null) logError("phi.soap_summary_decrypt_failed", new Error(`SoapNote ${plain._id} summary unreadable`));
    plain.summary = summary ?? "";
  }
  // Sanitise after decrypt so stored ciphertext stays byte-identical.
  return sanitizeSoapNote(plain);
}

export async function createSoapNote({ roomId, content, meetingId, meetingSessionId, sessionIndex, createdBy, summary }) {
  if (!roomId && !meetingId && !meetingSessionId) return null;
  if (!content) return null;
  const normalizedContent = sanitizeSoapContent(content);
  if (!Object.keys(normalizedContent).length) return null;
  const note = await SoapNote.create({
    roomId,
    content: encryptValues(normalizedContent, SOAP_CONTENT_CONTEXT),
    meetingId,
    meetingSessionId,
    sessionIndex,
    createdBy,
    summary: summary ? encryptField(summary, SOAP_SUMMARY_CONTEXT) : summary,
  });
  return decryptNote(note);
}

export async function getSoapNotesByRoom(roomId, options = {}) {
  if (!roomId) return [];
  const filter = { roomId };
  if (options.sessionIndex !== undefined && options.sessionIndex !== null) {
    filter.sessionIndex = options.sessionIndex;
  }
  if (options.meetingSessionId) {
    filter.meetingSessionId = options.meetingSessionId;
  }
  const notes = await SoapNote.find(filter).sort({ createdAt: -1 }).lean();
  return notes.map(decryptNote);
}

export async function getSoapNotesByMeeting(meetingId, options = {}) {
  if (!meetingId) return [];
  const filter = { meetingId };
  if (options.sessionIndex !== undefined && options.sessionIndex !== null) {
    filter.sessionIndex = options.sessionIndex;
  }
  if (options.meetingSessionId) {
    filter.meetingSessionId = options.meetingSessionId;
  }
  const notes = await SoapNote.find(filter).sort({ createdAt: -1 }).lean();
  return notes.map(decryptNote);
}

export async function getSoapNotesBySession(meetingSessionId) {
  if (!meetingSessionId) return [];
  const notes = await SoapNote.find({ meetingSessionId }).sort({ createdAt: -1 }).lean();
  return notes.map(decryptNote);
}

export async function getSoapNote(id) {
  if (!id) return null;
  const note = await SoapNote.findById(id).lean();
  return decryptNote(note);
}

export async function updateSoapNoteSection(id, section, value) {
  if (!id || !section) return null;
  const allowed = new Set(["subjective", "objective", "assessment", "plan"]);
  if (!allowed.has(section)) return null;

  const note = await SoapNote.findById(id);
  if (!note) return null;
  const nextContent = {
    ...(note.content || {}),
    [section]: encryptField(sanitizeClinicalHtml(value), `${SOAP_CONTENT_CONTEXT}.${section}`),
  };
  note.content = nextContent;
  note.markModified("content");
  await note.save();
  return decryptNote(note);
}
