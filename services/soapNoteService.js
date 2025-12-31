import { SoapNote } from "../models/soapNote.js";

export async function createSoapNote({ roomId, content, meetingId, createdBy, summary }) {
  if (!roomId && !meetingId) return null;
  if (!content) return null;
  const normalizedContent = typeof content === "string" ? { note: content } : content;
  return SoapNote.create({ roomId, content: normalizedContent, meetingId, createdBy, summary });
}

export async function getSoapNotesByRoom(roomId) {
  if (!roomId) return [];
  return SoapNote.find({ roomId }).sort({ createdAt: -1 }).lean();
}

export async function getSoapNotesByMeeting(meetingId) {
  if (!meetingId) return [];
  return SoapNote.find({ meetingId }).sort({ createdAt: -1 }).lean();
}

export async function getSoapNote(id) {
  if (!id) return null;
  return SoapNote.findById(id).lean();
}
