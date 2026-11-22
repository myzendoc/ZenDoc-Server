import { KnowledgeChunk } from "../models/knowledgeChunk.js";
import { SoapNote } from "../models/soapNote.js";
import { Transcript } from "../models/transcript.js";
import { PrivateNote } from "../models/privateNote.js";
import { Meeting } from "../models/meeting.js";
import { MeetingSession } from "../models/meetingSession.js";
import { decryptFieldOrNull, decryptValues, encryptField } from "../utils/fieldCipher.js";
import { SOAP_CONTENT_CONTEXT } from "./soapNoteService.js";
import { TRANSCRIPT_TEXT_CONTEXT } from "./transcriptService.js";
import { PRIVATE_NOTE_CONTEXT } from "./privateNoteService.js";
import { embedDocuments, EMBEDDING_DIMS, EMBEDDING_MODEL, isEmbeddingConfigured } from "./embeddingService.js";
import { packVector } from "../utils/vector.js";
import { normalizeLanguageCode } from "../utils/languages.js";
import { logError, logInfo } from "../utils/logging.js";

export const CHUNK_TEXT_CONTEXT = "KnowledgeChunk.text";

const SOAP_SECTIONS = ["subjective", "objective", "assessment", "plan"];
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS_PER_SOURCE = 40;

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Splits on paragraph boundaries where possible so a chunk stays readable.
export function splitIntoChunks(text, { size = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text || "").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < MAX_CHUNKS_PER_SOURCE) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
      if (breakAt > size * 0.5) end = start + breakAt + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

async function resolveMeetingContext(meetingId, roomId, meetingSessionId) {
  const filter = meetingId ? { _id: meetingId } : roomId ? { roomId } : null;
  if (!filter) return null;
  const meeting = await Meeting.findOne(filter, { createdBy: 1, roomId: 1, startedAt: 1, createdAt: 1 }).lean();
  if (!meeting) return null;
  // A room is reused across visits, so the session's own date wins.
  const session = meetingSessionId
    ? await MeetingSession.findById(meetingSessionId, { startedAt: 1 }).lean()
    : null;
  return {
    meetingId: meeting._id,
    roomId: meeting.roomId,
    ownerId: meeting.createdBy,
    occurredAt: session?.startedAt || meeting.startedAt || meeting.createdAt,
  };
}

async function writeChunks({ ownerId, meetingId, meetingSessionId, roomId, sessionIndex, sourceType, sourceId, occurredAt, language, pieces }) {
  if (!ownerId || !pieces.length) return 0;
  const vectors = await embedDocuments(pieces.map((piece) => piece.text));
  if (vectors.length !== pieces.length) {
    throw new Error(`Embedding count mismatch for ${sourceType}:${sourceId}`);
  }

  const docs = pieces.map((piece, index) => ({
    ownerId,
    meetingId,
    meetingSessionId,
    roomId,
    sessionIndex,
    sourceType,
    sourceId: String(sourceId || ""),
    section: piece.section,
    chunkIndex: index,
    text: encryptField(piece.text, CHUNK_TEXT_CONTEXT),
    language: normalizeLanguageCode(language) || undefined,
    vector: packVector(vectors[index]),
    dims: EMBEDDING_DIMS,
    model: EMBEDDING_MODEL,
    occurredAt,
  }));

  // Superseded chunks are removed outright: they are derived data, and the
  // source they came from still carries the retention clock.
  await KnowledgeChunk.deleteMany({ sourceType, sourceId: String(sourceId || "") });
  await KnowledgeChunk.insertMany(docs);
  return docs.length;
}

export async function indexSoapNote(noteId) {
  if (!isEmbeddingConfigured() || !noteId) return 0;
  const note = await SoapNote.findById(noteId).lean();
  if (!note) return 0;

  const context = await resolveMeetingContext(note.meetingId, note.roomId, note.meetingSessionId);
  const ownerId = note.createdBy || context?.ownerId;
  if (!ownerId) return 0;

  const content = decryptValues(note.content || {}, SOAP_CONTENT_CONTEXT);
  const pieces = [];
  for (const section of SOAP_SECTIONS) {
    const text = stripHtml(content?.[section]);
    if (!text) continue;
    for (const chunk of splitIntoChunks(text)) {
      pieces.push({ section, text: `${section.toUpperCase()}: ${chunk}` });
    }
  }

  return writeChunks({
    ownerId,
    meetingId: note.meetingId || context?.meetingId,
    meetingSessionId: note.meetingSessionId,
    roomId: note.roomId || context?.roomId,
    sessionIndex: note.sessionIndex,
    sourceType: "soap",
    sourceId: note._id,
    occurredAt: context?.occurredAt || note.createdAt,
    language: note.language,
    pieces,
  });
}

export async function indexPrivateNote(noteId) {
  if (!isEmbeddingConfigured() || !noteId) return 0;
  const note = await PrivateNote.findById(noteId).lean();
  if (!note) return 0;

  const context = await resolveMeetingContext(note.meetingId, note.roomId, note.meetingSessionId);
  const ownerId = note.createdBy || context?.ownerId;
  if (!ownerId) return 0;

  const text = stripHtml(decryptFieldOrNull(note.content, PRIVATE_NOTE_CONTEXT) ?? "");
  const pieces = splitIntoChunks(text).map((chunk) => ({ section: "private note", text: chunk }));

  return writeChunks({
    ownerId,
    meetingId: note.meetingId,
    meetingSessionId: note.meetingSessionId,
    roomId: note.roomId,
    sessionIndex: note.sessionIndex,
    sourceType: "private_note",
    sourceId: note._id,
    occurredAt: context?.occurredAt || note.createdAt,
    pieces,
  });
}

// One session's transcript lines are stitched together, then chunked, so a
// retrieved passage carries enough of the conversation to be useful.
export async function indexSessionTranscript({ roomId, sessionIndex, meetingSessionId }) {
  if (!isEmbeddingConfigured() || !roomId) return 0;
  const filter = { roomId };
  if (sessionIndex !== undefined && sessionIndex !== null) filter.sessionIndex = sessionIndex;
  if (meetingSessionId) filter.meetingSessionId = meetingSessionId;

  const docs = await Transcript.find(filter).sort({ createdAt: 1 }).lean();
  if (!docs.length) return 0;

  const context = await resolveMeetingContext(null, roomId, meetingSessionId);
  if (!context?.ownerId) return 0;

  const languages = new Map();
  const lines = [];
  for (const doc of docs) {
    const text = decryptFieldOrNull(doc.text, TRANSCRIPT_TEXT_CONTEXT);
    if (!text) continue;
    lines.push(text);
    const code = normalizeLanguageCode(doc.language);
    if (code) languages.set(code, (languages.get(code) || 0) + 1);
  }
  if (!lines.length) return 0;

  const dominant = [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const pieces = splitIntoChunks(lines.join("\n")).map((chunk) => ({ section: "transcript", text: chunk }));
  const sourceId = meetingSessionId || `${roomId}:${sessionIndex ?? 0}`;

  return writeChunks({
    ownerId: context.ownerId,
    meetingId: context.meetingId,
    meetingSessionId,
    roomId,
    sessionIndex,
    sourceType: "transcript",
    sourceId,
    occurredAt: context.occurredAt || docs[0]?.createdAt,
    language: dominant,
    pieces,
  });
}

export async function removeChunksForSource(sourceType, sourceId, { actorId, reason } = {}) {
  if (!sourceType || !sourceId) return 0;
  const result = await KnowledgeChunk.softDelete(
    { sourceType, sourceId: String(sourceId) },
    { actorId, reason: reason || "source deleted" }
  );
  return result?.modifiedCount || 0;
}

export async function removeChunksForMeeting(meetingId, { actorId, reason } = {}) {
  if (!meetingId) return 0;
  const result = await KnowledgeChunk.softDelete(
    { meetingId },
    { actorId, reason: reason || "meeting deleted" }
  );
  return result?.modifiedCount || 0;
}

// Indexing never blocks the request that produced the note.
export function indexInBackground(task, label) {
  Promise.resolve()
    .then(task)
    .then((count) => {
      if (count) logInfo("knowledge.indexed", { source: label, chunks: count });
    })
    .catch((err) => logError(`knowledge.index_failed.${label}`, err));
}

export async function indexSessionArtifacts({ roomId, sessionIndex, meetingSessionId, soapNoteId }) {
  let total = 0;
  total += await indexSessionTranscript({ roomId, sessionIndex, meetingSessionId });
  if (soapNoteId) total += await indexSoapNote(soapNoteId);
  return total;
}

// Catches anything the live path missed, for example a note written while the
// embedding API was unavailable.
export async function backfillMissingChunks({ limit = 25 } = {}) {
  if (!isEmbeddingConfigured()) return { skipped: "embeddings unconfigured" };

  const indexed = await KnowledgeChunk.distinct("sourceId", { sourceType: "soap" });
  const indexedIds = new Set(indexed.map(String));
  const notes = await SoapNote.find({}, { _id: 1 }).sort({ createdAt: -1 }).limit(limit * 4).lean();
  const pending = notes.filter((note) => !indexedIds.has(String(note._id))).slice(0, limit);

  let chunks = 0;
  for (const note of pending) {
    try {
      chunks += await indexSoapNote(note._id);
    } catch (err) {
      logError("knowledge.backfill_note_failed", err);
    }
  }
  return { notes: pending.length, chunks };
}
