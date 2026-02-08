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

export async function getTranscriptsByRoom(roomId) {
  if (!roomId) return [];
  return Transcript.find({ roomId }).sort({ createdAt: 1 }).lean();
}

export async function getParticipantsByRooms(roomIds = []) {
  if (!roomIds.length) return 0;
  const docs = await Transcript.find({ roomId: { $in: roomIds } }, { peerId: 1, roomId: 1 }).lean();
  const uniquePeers = new Set();
  docs.forEach((d) => {
    if (d?.peerId) uniquePeers.add(`${d.roomId}:${d.peerId}`);
  });
  return uniquePeers.size;
}
