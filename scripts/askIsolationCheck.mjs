// End-to-end check for the Ask feature's HIPAA controls. Stubs the Agent
// Platform calls so nothing leaves the machine, everything else is real.
// Run: node --experimental-test-module-mocks scripts/askIsolationCheck.mjs
import { mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27779/zendoc_ask_check";
process.env.PHI_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString("base64")}`;
process.env.PHI_ACTIVE_KEY_ID = "v1";
process.env.AUDIT_CHAIN_SECRET = crypto.randomBytes(32).toString("hex");
process.env.GOOGLE_CLOUD_PROJECT = "stub-project";
process.env.ENABLE_SCHEDULED_JOBS = "false";
process.env.NODE_ENV = "test";

const DIMS = 768;

// Deterministic pseudo-embeddings: texts sharing vocabulary land near each other.
function fakeEmbed(text) {
  const vector = new Array(DIMS).fill(0);
  for (const word of String(text).toLowerCase().match(/[a-z]{3,}/g) || []) {
    const hash = crypto.createHash("sha256").update(word).digest();
    for (let i = 0; i < 8; i += 1) {
      vector[((hash[i] << 8) | hash[i + 8]) % DIMS] += 1;
    }
  }
  return vector;
}

let lastPrompt = "";
let lastContext = "";

mock.module("../services/embeddingService.js", {
  namedExports: {
    EMBEDDING_MODEL: "stub-embedding",
    EMBEDDING_DIMS: DIMS,
    isEmbeddingConfigured: () => true,
    embedDocuments: async (texts) => {
      const { normalizeVector } = await import("../utils/vector.js");
      return texts.map((text) => normalizeVector(fakeEmbed(text)));
    },
    embedQuery: async (text) => {
      const { normalizeVector } = await import("../utils/vector.js");
      return normalizeVector(fakeEmbed(text));
    },
  },
});

const { default: mongoose } = await import("mongoose");
const { normalizeVector } = await import("../utils/vector.js");

// ES module namespaces are frozen, so the whole module is replaced.
mock.module("../services/soapsService.js", {
  namedExports: {
    getAgentPlatformClient: () => ({
      models: {
        generateContent: async ({ contents }) => {
          lastPrompt = contents?.[0]?.parts?.[0]?.text || "";
          lastContext = lastPrompt.split("\n\nQuestion:")[0];
          return { text: "Stubbed answer citing [1]." };
        },
      },
    }),
    getSoapAuthMode: () => "application_default_credentials",
    isSoapGenerationConfigured: () => true,
    generateSoaps: async () => null,
  },
});

const { User } = await import("../models/user.js");
const { Meeting } = await import("../models/meeting.js");
const { MeetingSession } = await import("../models/meetingSession.js");
const { SoapNote } = await import("../models/soapNote.js");
const { Transcript } = await import("../models/transcript.js");
const { KnowledgeChunk } = await import("../models/knowledgeChunk.js");
const { AuditLog } = await import("../models/auditLog.js");
const { encryptField, encryptValues, isEncrypted } = await import("../utils/fieldCipher.js");
const { SOAP_CONTENT_CONTEXT } = await import("../services/soapNoteService.js");
const { TRANSCRIPT_TEXT_CONTEXT } = await import("../services/transcriptService.js");
const { indexSoapNote, indexSessionTranscript } = await import("../services/knowledgeIndexService.js");
const { askQuestion } = await import("../services/askService.js");
const { deleteMeetingSessionWithData } = await import("../services/meetingSessionService.js");

await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.dropDatabase();

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}\n      ${err.message}`);
  }
}

async function seedProvider({ email, roomId, title, soap, transcriptLines, language }) {
  const user = await User.create({
    email,
    firstName: email.split("@")[0],
    role: "provider",
    status: "active",
  });
  const meeting = await Meeting.create({
    roomId,
    title: encryptField(title, "Meeting.title"),
    createdBy: user._id,
    startedAt: new Date("2026-11-02T10:00:00Z"),
    transcriptLanguage: language || "auto",
  });
  const session = await MeetingSession.create({
    meetingId: meeting._id,
    roomId,
    sessionIndex: 0,
    startedAt: new Date("2026-11-02T10:00:00Z"),
    endedAt: new Date("2026-11-02T10:25:00Z"),
  });
  const note = await SoapNote.create({
    roomId,
    meetingId: meeting._id,
    meetingSessionId: session._id,
    sessionIndex: 0,
    createdBy: user._id,
    language: language || "en",
    content: encryptValues(soap, SOAP_CONTENT_CONTEXT),
  });
  for (const line of transcriptLines) {
    await Transcript.create({
      roomId,
      peerId: "peer-1",
      sessionIndex: 0,
      meetingSessionId: session._id,
      language: language || "en",
      text: encryptField(line, TRANSCRIPT_TEXT_CONTEXT),
    });
  }
  return { user, meeting, session, note };
}

const alice = await seedProvider({
  email: "alice@example.test",
  roomId: "room-alice",
  title: "Chris Walker follow-up",
  soap: {
    subjective: "<p>Patient reports persistent migraine headaches with photophobia.</p>",
    objective: "<p>Blood pressure 128/82. Neurological examination unremarkable.</p>",
    assessment: "<p>1. Chronic migraine without aura.</p>",
    plan: "<p>- Start sumatriptan 50mg as needed.</p><p>- Review in four weeks.</p>",
  },
  transcriptLines: [
    "The migraine headaches have been getting worse over the last month.",
    "Light sensitivity is the worst symptom, especially in the mornings.",
  ],
});

const bob = await seedProvider({
  email: "bob@example.test",
  roomId: "room-bob",
  title: "Dana Reyes diabetes review",
  soap: {
    subjective: "<p>Patient reports increased thirst and nocturia for three weeks.</p>",
    objective: "<p>HbA1c 8.4 percent. Weight stable.</p>",
    assessment: "<p>1. Type 2 diabetes with suboptimal glycaemic control.</p>",
    plan: "<p>- Increase metformin to 1000mg twice daily.</p>",
  },
  transcriptLines: ["My thirst has been unbearable and I am up all night urinating."],
  language: "es",
});

const aliceChunks = await indexSoapNote(alice.note._id);
const aliceTranscriptChunks = await indexSessionTranscript({
  roomId: "room-alice",
  sessionIndex: 0,
  meetingSessionId: alice.session._id,
});
const bobChunks = await indexSoapNote(bob.note._id);

check("indexing produced chunks for both providers", () => {
  assert.ok(aliceChunks > 0, "alice soap produced no chunks");
  assert.ok(aliceTranscriptChunks > 0, "alice transcript produced no chunks");
  assert.ok(bobChunks > 0, "bob soap produced no chunks");
});

const aliceOwned = await KnowledgeChunk.countDocuments({ ownerId: alice.user._id });
const bobOwned = await KnowledgeChunk.countDocuments({ ownerId: bob.user._id });
check("ownership is recorded per chunk", () => {
  assert.equal(aliceOwned, aliceChunks + aliceTranscriptChunks);
  assert.equal(bobOwned, bobChunks);
});

const rawChunk = await KnowledgeChunk.collection.findOne({ ownerId: alice.user._id });
check("chunk text is encrypted at rest", () => {
  assert.ok(isEncrypted(rawChunk.text), "chunk text is stored as plaintext");
  assert.ok(!String(rawChunk.text).includes("migraine"), "plaintext PHI leaked into storage");
});

check("stored vectors are packed float32 of the expected width", () => {
  assert.equal(rawChunk.dims, DIMS);
  assert.equal(rawChunk.vector.buffer.byteLength ?? rawChunk.vector.length(), DIMS * 4);
});

const aliceAnswer = await askQuestion({
  question: "What symptoms did the patient report about headaches?",
  actor: { _id: alice.user._id, role: "provider", email: alice.user.email },
  request: { ipAddress: "127.0.0.1", userAgent: "check" },
});

check("the owning provider gets a cited answer", () => {
  assert.ok(!aliceAnswer.error, `unexpected error: ${aliceAnswer.error}`);
  assert.ok(aliceAnswer.sources.length > 0, "no sources returned");
  assert.ok(aliceAnswer.answer.includes("[1]"), "answer carried no citation");
});

check("retrieved sources name the right visit", () => {
  assert.equal(aliceAnswer.sources[0].meetingTitle, "Chris Walker follow-up");
  assert.ok(aliceAnswer.sources.every((s) => s.excerpt), "a source came back with no excerpt");
});

check("ISOLATION: the retrieved context holds no other provider's PHI", () => {
  for (const term of ["metformin", "nocturia", "HbA1c", "Dana Reyes", "diabetes"]) {
    assert.ok(!lastContext.includes(term), `context leaked "${term}" from another provider`);
  }
  assert.ok(lastContext.includes("migraine"), "context was missing the caller's own records");
});

check("ISOLATION: no returned source belongs to another provider", () => {
  for (const source of aliceAnswer.sources) {
    assert.notEqual(source.meetingId, String(bob.meeting._id));
    assert.notEqual(source.meetingTitle, "Dana Reyes diabetes review");
  }
});

lastPrompt = "";
lastContext = "";
const bobAnswer = await askQuestion({
  question: "What symptoms did the patient report about headaches?",
  actor: { _id: bob.user._id, role: "provider", email: bob.user.email },
  request: { ipAddress: "127.0.0.1", userAgent: "check" },
});
check("ISOLATION: the other provider reaches none of those records", () => {
  assert.equal(bobAnswer.sources.length, 0, "the other provider retrieved something");
  assert.equal(lastPrompt, "", "the model was called with another provider's question context");
  assert.ok(bobAnswer.searched > 0, "bob's own records were not searched at all");
  assert.ok(/nothing/i.test(bobAnswer.answer), `unexpected answer: ${bobAnswer.answer}`);
});

const noActor = await askQuestion({ question: "anything", actor: null });
check("a caller with no identity is refused", () => {
  assert.equal(noActor.status, 403);
});

const empty = await askQuestion({
  question: "",
  actor: { _id: alice.user._id, role: "provider" },
});
check("an empty question is rejected before any API call", () => {
  assert.equal(empty.status, 400);
});

const aliceSecond = await seedProvider({
  email: "alice2@example.test",
  roomId: "room-alice-2",
  title: "Chris Walker ankle injury",
  soap: {
    subjective: "<p>Patient twisted the ankle descending stairs.</p>",
    objective: "<p>Swelling over the lateral malleolus. Ottawa rules negative.</p>",
    assessment: "<p>1. Grade two ankle sprain.</p>",
    plan: "<p>- Ibuprofen 400mg three times daily with food.</p>",
  },
  transcriptLines: ["I twisted my ankle on the stairs and the swelling came up fast."],
});
await Meeting.updateOne({ _id: aliceSecond.meeting._id }, { $set: { createdBy: alice.user._id } });
await SoapNote.updateOne({ _id: aliceSecond.note._id }, { $set: { createdBy: alice.user._id } });
await indexSoapNote(aliceSecond.note._id);

const ownedChunkCount = await KnowledgeChunk.countDocuments({ ownerId: alice.user._id });
lastPrompt = "";
lastContext = "";
const crossVisit = await askQuestion({
  question: "ankle sprain swelling lateral malleolus ibuprofen dose",
  actor: { _id: alice.user._id, role: "provider" },
});
check("a global Ask considers every visit the provider owns", () => {
  assert.equal(crossVisit.searched, ownedChunkCount, "retrieval did not scan all owned chunks");
  assert.ok(crossVisit.sources.length > 0, "the second visit was not reachable");
  const titles = crossVisit.sources.map((source) => source.meetingTitle);
  assert.ok(titles.includes("Chris Walker ankle injury"), `second visit missing from ${titles.join(", ")}`);
});

lastPrompt = "";
lastContext = "";
const scopedOther = await askQuestion({
  question: "ankle sprain swelling lateral malleolus ibuprofen dose",
  actor: { _id: alice.user._id, role: "provider" },
  meetingSessionId: alice.session._id,
});
check("SCOPING: a note-scoped Ask cannot see the provider's other visits", () => {
  for (const term of ["Ibuprofen", "malleolus", "sprain"]) {
    assert.ok(!lastContext.includes(term), `the scoped context leaked "${term}" from another visit`);
  }
  for (const source of scopedOther.sources || []) {
    assert.notEqual(source.meetingTitle, "Chris Walker ankle injury");
  }
});

lastPrompt = "";
lastContext = "";
const scoped = await askQuestion({
  question: "What is the plan for this visit?",
  actor: { _id: alice.user._id, role: "provider" },
  meetingSessionId: alice.session._id,
});
const scopedChunks = await KnowledgeChunk.find(
  { ownerId: alice.user._id, meetingSessionId: alice.session._id },
  { _id: 1 }
).lean();
check("session-scoped Ask returns only that session's records", () => {
  assert.ok(!scoped.error, `unexpected error: ${scoped.error}`);
  assert.ok(scoped.sources.length > 0, "scoped ask found nothing");
  assert.ok(scopedChunks.length > 0, "the session had nothing indexed");
  for (const source of scoped.sources) {
    assert.equal(source.meetingTitle, "Chris Walker follow-up", "a foreign visit was returned");
  }
  assert.ok(!lastContext.includes("metformin"), "scoped context leaked another provider's plan");
  assert.ok(!lastContext.includes("Ibuprofen"), "scoped context leaked another visit");
});

async function waitForAuditEntries(expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let logs = [];
  while (Date.now() < deadline) {
    logs = await AuditLog.find({ action: { $in: ["ask.search", "ask.note_query"] } }).lean();
    if (logs.length >= expected) return logs;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return logs;
}
const askLogs = await waitForAuditEntries(5);
check("every Ask is audited with the records it disclosed", () => {
  assert.ok(askLogs.length >= 5, `expected audit entries, found ${askLogs.length}`);
  const search = askLogs.find((log) => log.action === "ask.search");
  assert.ok(search, "no ask.search audit entry");
  assert.equal(search.actorRole, "provider");
  assert.ok(search.metadata.sourceCount > 0, "audit entry recorded no disclosure count");
  assert.ok(Array.isArray(search.metadata.disclosedSources), "audit entry listed no sources");
  assert.ok(search.entryHash, "audit entry was not chained");
});

check("the audit trail does not store the question text", () => {
  const serialized = JSON.stringify(askLogs);
  assert.ok(!serialized.includes("headaches"), "the question text was written to the audit log");
});

await deleteMeetingSessionWithData(alice.session._id, { actorId: alice.user._id, reason: "check" });
const afterDelete = await askQuestion({
  question: "What symptoms did the patient report about headaches?",
  actor: { _id: alice.user._id, role: "provider" },
});
check("deleted visits stop being searchable", () => {
  const titles = (afterDelete.sources || []).map((s) => s.meetingTitle);
  assert.ok(!titles.includes("Chris Walker follow-up"), "a deleted visit is still retrievable");
});

const survivingChunks = await KnowledgeChunk.countDocuments({ meetingSessionId: alice.session._id });
const softDeleted = await KnowledgeChunk.countDocuments({
  meetingSessionId: alice.session._id,
  deletedAt: { $ne: null },
}).setOptions({ includeDeleted: true });
const otherVisitChunks = await KnowledgeChunk.countDocuments({ meetingSessionId: aliceSecond.session._id });
check("deletion is soft and confined to the deleted session", () => {
  assert.equal(survivingChunks, 0, "the deleted session's chunks remained visible");
  assert.ok(softDeleted > 0, "chunks were hard-deleted instead of soft-deleted");
  assert.ok(otherVisitChunks > 0, "deleting one visit removed another visit's chunks");
});

const reindexed = await indexSoapNote(bob.note._id);
const bobTotal = await KnowledgeChunk.countDocuments({ ownerId: bob.user._id });
check("re-indexing replaces rather than duplicates", () => {
  assert.equal(bobTotal, reindexed, `expected ${reindexed} chunks, found ${bobTotal}`);
});

await mongoose.disconnect();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
