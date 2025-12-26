import { Transcript } from "../models/transcript.js";

export async function saveFinalTranscript({ roomId, peerId, text }) {
  if (!roomId || !text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return Transcript.create({ roomId, peerId, text: trimmed });
}

export async function getRoomTranscript(roomId) {
  if (!roomId) return "";
  const docs = await Transcript.find({ roomId }).sort({ createdAt: 1 }).lean();
  return docs.map((doc) => doc.text).join("\n");
}
