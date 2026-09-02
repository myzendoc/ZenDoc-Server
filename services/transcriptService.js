import { Transcript } from "../models/transcript.js";
import { decryptFieldOrNull, encryptField } from "../utils/fieldCipher.js";
import { logError } from "../utils/logging.js";

// Reads use .lean(), which bypasses getters, so encryption is explicit here.
export const TRANSCRIPT_TEXT_CONTEXT = "Transcript.text";

function readTranscriptText(doc) {
  const text = decryptFieldOrNull(doc?.text, TRANSCRIPT_TEXT_CONTEXT);
  if (text === null) {
    logError("phi.transcript_decrypt_failed", new Error(`Transcript ${doc?._id} could not be decrypted`));
    return "";
  }
  return text;
}

export function decryptTranscriptDoc(doc) {
  if (!doc) return doc;
  return { ...doc, text: readTranscriptText(doc) };
}

export async function saveFinalTranscript({ roomId, peerId, text, sessionIndex, meetingSessionId }) {
  if (!roomId || !text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return Transcript.create({
    roomId,
    peerId,
    text: encryptField(trimmed, TRANSCRIPT_TEXT_CONTEXT),
    sessionIndex,
    meetingSessionId,
  });
}

export async function getRoomTranscript(roomId, sessionIndex) {
  if (!roomId) return "";
  const filter = { roomId };
  if (sessionIndex !== undefined && sessionIndex !== null) {
    filter.sessionIndex = sessionIndex;
  }
  const docs = await Transcript.find(filter).sort({ createdAt: 1 }).lean();
  return docs.map(readTranscriptText).filter(Boolean).join("\n");
}

export async function getTranscriptsByRoom(roomId, options = {}) {
  if (!roomId) return [];
  const filter = { roomId };
  if (options.sessionIndex !== undefined && options.sessionIndex !== null) {
    filter.sessionIndex = options.sessionIndex;
  }
  if (options.meetingSessionId) {
    filter.meetingSessionId = options.meetingSessionId;
  }
  const docs = await Transcript.find(filter).sort({ createdAt: 1 }).lean();
  return docs.map(decryptTranscriptDoc);
}

export async function getParticipantsByRooms(roomIds = []) {
  if (!roomIds.length) return 0;
  const docs = await Transcript.find({ roomId: { $in: roomIds } }, { peerId: 1, roomId: 1, sessionIndex: 1 }).lean();
  const uniquePeers = new Set();
  docs.forEach((d) => {
    if (d?.peerId) uniquePeers.add(`${d.roomId}:${d.sessionIndex ?? 0}:${d.peerId}`);
  });
  return uniquePeers.size;
}

export async function getParticipantCountsByRoomSession(roomIds = []) {
  if (!roomIds.length) return {};
  const docs = await Transcript.find({ roomId: { $in: roomIds } }, { peerId: 1, roomId: 1, sessionIndex: 1 }).lean();
  const uniquePeers = new Set();
  const counts = {};

  docs.forEach((d) => {
    if (!d?.peerId || !d?.roomId) return;
    const sessionKey = `${d.roomId}:${d.sessionIndex ?? 0}`;
    const participantKey = `${sessionKey}:${d.peerId}`;
    if (uniquePeers.has(participantKey)) return;
    uniquePeers.add(participantKey);
    counts[sessionKey] = (counts[sessionKey] || 0) + 1;
  });

  return counts;
}
