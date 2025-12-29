import { SoapNote } from "../models/soapNote.js";

export async function createSoapNote({ roomId, content }) {
  if (!roomId || !content) return null;
  return SoapNote.create({ roomId, content });
}

export async function getSoapNotesByRoom(roomId) {
  if (!roomId) return [];
  return SoapNote.find({ roomId }).sort({ createdAt: -1 }).lean();
}

export async function getSoapNote(id) {
  if (!id) return null;
  return SoapNote.findById(id).lean();
}
