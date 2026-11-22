import { KnowledgeChunk } from "../models/knowledgeChunk.js";
import { Meeting } from "../models/meeting.js";
import { MeetingSession } from "../models/meetingSession.js";
import { decryptFieldOrNull } from "../utils/fieldCipher.js";
import { CHUNK_TEXT_CONTEXT } from "./knowledgeIndexService.js";
import { MEETING_TITLE_CONTEXT } from "./meetingService.js";
import { SESSION_AUTO_TITLE_CONTEXT, SESSION_TITLE_CONTEXT } from "./meetingSessionService.js";
import { embedQuery, isEmbeddingConfigured } from "./embeddingService.js";
import { getAgentPlatformClient } from "./soapsService.js";
import { dotProduct, topK, unpackVector } from "../utils/vector.js";
import { createAuditLog } from "./auditLogService.js";
import { logError } from "../utils/logging.js";

const ANSWER_MODEL = "gemini-2.5-flash";
const MAX_QUESTION_CHARS = 1000;
const CANDIDATE_LIMIT = 1500;
const DEFAULT_TOP_K = 8;
const SCOPED_TOP_K = 14;
const MIN_SCORE = 0.3;
const EXCERPT_CHARS = 320;

const SYSTEM_INSTRUCTION = `You are a clinical records assistant for one healthcare provider. Answer only from the numbered record excerpts supplied in the prompt.

Rules:
- Cite the excerpts you used as [1], [2] and so on, inline, right after the statement they support.
- If the excerpts do not contain the answer, say so plainly and do not speculate. Never invent clinical detail.
- Quote values, doses, dates and measurements exactly as they appear.
- Be concise. Lead with the direct answer, then the supporting detail.
- Answer in the same language the question was asked in.
- You are addressing the treating provider, so clinical terminology is appropriate.`;

export function isAskConfigured() {
  return isEmbeddingConfigured();
}

function normalizeQuestion(value) {
  return String(value || "").trim().slice(0, MAX_QUESTION_CHARS);
}

function readChunkText(doc) {
  const text = decryptFieldOrNull(doc?.text, CHUNK_TEXT_CONTEXT);
  if (text === null) {
    logError("phi.chunk_decrypt_failed", new Error(`KnowledgeChunk ${doc?._id} could not be decrypted`));
    return "";
  }
  return text;
}

// The AI visit title is what the provider recognises in a list, so it beats
// the room's generic title when one exists.
async function resolveSourceTitles(matches = []) {
  const meetingIds = [...new Set(matches.map((item) => item.doc.meetingId).filter(Boolean).map(String))];
  const sessionIds = [...new Set(matches.map((item) => item.doc.meetingSessionId).filter(Boolean).map(String))];

  const [meetings, sessions] = await Promise.all([
    meetingIds.length
      ? Meeting.find({ _id: { $in: meetingIds } }, { title: 1, startedAt: 1, createdAt: 1 }).lean()
      : [],
    sessionIds.length
      ? MeetingSession.find({ _id: { $in: sessionIds } }, { title: 1, autoTitle: 1, startedAt: 1 }).lean()
      : [],
  ]);

  const byMeeting = new Map(
    meetings.map((meeting) => [
      String(meeting._id),
      {
        title: decryptFieldOrNull(meeting.title, MEETING_TITLE_CONTEXT) || "Untitled visit",
        occurredAt: meeting.startedAt || meeting.createdAt || null,
      },
    ])
  );
  const bySession = new Map(
    sessions.map((session) => [
      String(session._id),
      {
        title:
          decryptFieldOrNull(session.autoTitle, SESSION_AUTO_TITLE_CONTEXT) ||
          decryptFieldOrNull(session.title, SESSION_TITLE_CONTEXT) ||
          "",
        occurredAt: session.startedAt || null,
      },
    ])
  );

  return (doc) => {
    const session = bySession.get(String(doc.meetingSessionId));
    const meeting = byMeeting.get(String(doc.meetingId));
    return {
      title: session?.title || meeting?.title || "Untitled visit",
      occurredAt: session?.occurredAt || meeting?.occurredAt || null,
    };
  };
}

const SOURCE_LABELS = { soap: "SOAP note", transcript: "Visit transcript", private_note: "Private note" };

function describeSource(entry, meta) {
  const when = entry.occurredAt || meta?.occurredAt;
  const date = when ? new Date(when).toISOString().slice(0, 10) : "unknown date";
  const label = SOURCE_LABELS[entry.sourceType] || entry.sourceType;
  return `${meta?.title || "Untitled visit"} — ${label}${entry.section ? ` (${entry.section})` : ""}, ${date}`;
}

// Retrieval is always pinned to the requesting provider's own records; the
// caller cannot widen it. Admins have no Ask access — break-glass covers that.
async function retrieve({ ownerId, queryVector, meetingId, meetingSessionId, limit }) {
  const filter = { ownerId };
  if (meetingSessionId) filter.meetingSessionId = meetingSessionId;
  else if (meetingId) filter.meetingId = meetingId;

  const docs = await KnowledgeChunk.find(filter, {
    vector: 1,
    text: 1,
    sourceType: 1,
    sourceId: 1,
    section: 1,
    meetingId: 1,
    meetingSessionId: 1,
    occurredAt: 1,
    language: 1,
  })
    .sort({ occurredAt: -1 })
    .limit(CANDIDATE_LIMIT)
    .lean();

  if (!docs.length) return { matches: [], candidates: 0 };

  const scored = [];
  for (const doc of docs) {
    const vector = unpackVector(doc.vector);
    if (vector.length !== queryVector.length) continue;
    scored.push({ doc, score: dotProduct(queryVector, vector) });
  }

  const matches = topK(scored, limit).filter((item) => item.score >= MIN_SCORE);
  return { matches, candidates: docs.length };
}

async function answerFromSources({ question, sources, today }) {
  const context = sources
    .map((source) => `[${source.index}] ${source.descriptor}\n${source.text}`)
    .join("\n\n---\n\n");

  const response = await getAgentPlatformClient().models.generateContent({
    model: ANSWER_MODEL,
    contents: [
      {
        role: "user",
        parts: [{ text: `Today is ${today}.\n\nRecord excerpts:\n\n${context}\n\nQuestion: ${question}` }],
      },
    ],
    config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.2 },
  });
  return response?.text?.trim() || "";
}

export async function askQuestion({ question, actor, meetingId, meetingSessionId, request } = {}) {
  const prompt = normalizeQuestion(question);
  if (!prompt) {
    return { error: "Ask a question first", status: 400 };
  }
  if (!isAskConfigured()) {
    return { error: "AI search is not configured on this server", status: 503 };
  }
  const ownerId = actor?._id;
  if (!ownerId) {
    return { error: "Not allowed", status: 403 };
  }

  const queryVector = await embedQuery(prompt);
  if (!queryVector?.length) {
    return { error: "Could not process that question, try again", status: 502 };
  }

  const scoped = Boolean(meetingId || meetingSessionId);
  const { matches, candidates } = await retrieve({
    ownerId,
    queryVector,
    meetingId,
    meetingSessionId,
    limit: scoped ? SCOPED_TOP_K : DEFAULT_TOP_K,
  });

  const titleFor = await resolveSourceTitles(matches);
  const sources = [];
  for (const [position, item] of matches.entries()) {
    const text = readChunkText(item.doc);
    if (!text) continue;
    const meta = titleFor(item.doc);
    sources.push({
      index: position + 1,
      text,
      descriptor: describeSource(item.doc, meta),
      meetingId: item.doc.meetingId ? String(item.doc.meetingId) : "",
      meetingTitle: meta?.title || "Untitled visit",
      sourceType: item.doc.sourceType,
      section: item.doc.section || "",
      occurredAt: item.doc.occurredAt || meta?.occurredAt || null,
      score: Number(item.score.toFixed(4)),
    });
  }

  // Record which records were disclosed, not the question, which is PHI itself.
  const auditSources = sources.map((source) => `${source.sourceType}:${source.meetingId}`);
  createAuditLog({
    actorUserId: String(ownerId),
    actorRole: actor?.role === "admin" ? "admin" : "provider",
    actorEmail: actor?.email || null,
    actorName: actor?.displayName || actor?.firstName || null,
    action: scoped ? "ask.note_query" : "ask.search",
    resourceType: scoped ? "meeting" : "knowledge_search",
    resourceId: String(meetingSessionId || meetingId || "") || undefined,
    status: "success",
    ipAddress: request?.ipAddress,
    country: request?.country,
    userAgent: request?.userAgent,
    method: "POST",
    path: scoped ? "/ask/meeting/:meetingId" : "/ask",
    metadata: {
      scope: scoped ? "meeting" : "all_records",
      candidateCount: candidates,
      sourceCount: sources.length,
      disclosedSources: auditSources.slice(0, 20),
    },
  }).catch((err) => logError("audit.ask_write_failed", err));

  if (!sources.length) {
    return {
      answer: candidates
        ? "Nothing in your records matches that question."
        : "There is nothing indexed yet. Records are searchable once a visit has notes or a transcript.",
      sources: [],
      searched: candidates,
    };
  }

  try {
    const answer = await answerFromSources({
      question: prompt,
      sources,
      today: new Date().toISOString().slice(0, 10),
    });
    if (!answer) return { error: "No answer came back, try again", status: 502 };
    return {
      answer,
      searched: candidates,
      sources: sources.map(({ text, descriptor, score, ...rest }) => ({
        ...rest,
        excerpt: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text,
      })),
    };
  } catch (err) {
    logError("ask.answer_failed", err);
    return { error: "AI search is unavailable right now", status: 502 };
  }
}

export async function getAskStatus(ownerId) {
  if (!ownerId) return { configured: false, indexedChunks: 0, indexedVisits: 0 };
  const [indexedChunks, meetings] = await Promise.all([
    KnowledgeChunk.countDocuments({ ownerId }),
    KnowledgeChunk.distinct("meetingId", { ownerId }),
  ]);
  return {
    configured: isAskConfigured(),
    indexedChunks,
    indexedVisits: meetings.filter(Boolean).length,
  };
}
