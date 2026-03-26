import { SoapNote } from "../models/soapNote.js";

export async function createSoapNote({ roomId, content, meetingId, meetingSessionId, sessionIndex, createdBy, summary }) {
  if (!roomId && !meetingId && !meetingSessionId) return null;
  if (!content) return null;
  const normalizedContent = typeof content === "string" ? { note: content } : content;
  return SoapNote.create({ roomId, content: normalizedContent, meetingId, meetingSessionId, sessionIndex, createdBy, summary });
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
  return SoapNote.find(filter).sort({ createdAt: -1 }).lean();
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
  return SoapNote.find(filter).sort({ createdAt: -1 }).lean();
}

export async function getSoapNotesBySession(meetingSessionId) {
  if (!meetingSessionId) return [];
  return SoapNote.find({ meetingSessionId }).sort({ createdAt: -1 }).lean();
}

export async function getSoapNote(id) {
  if (!id) return null;
  return SoapNote.findById(id).lean();
}

export async function updateSoapNoteSection(id, section, value) {
  if (!id || !section) return null;
  const allowed = new Set(["subjective", "objective", "assessment", "plan"]);
  if (!allowed.has(section)) return null;

  const note = await SoapNote.findById(id);
  if (!note) return null;
  const nextContent = { ...(note.content || {}), [section]: value };
  note.content = nextContent;
  await note.save();
  return note.toObject();
}
