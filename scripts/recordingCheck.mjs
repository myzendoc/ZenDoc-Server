// Checks voice visits and uploaded recordings: transcription, note creation,
// the free-upload limit, and that no audio is ever persisted.
// Deepgram and Gemini are stubbed unless RECORDING_CHECK_LIVE=1.
// Run: node --experimental-test-module-mocks scripts/recordingCheck.mjs
import { mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27779/zendoc_recording_check";
process.env.PHI_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString("base64")}`;
process.env.PHI_ACTIVE_KEY_ID = "v1";
process.env.AUDIT_CHAIN_SECRET = crypto.randomBytes(32).toString("hex");
process.env.GOOGLE_CLOUD_PROJECT = "stub-project";
process.env.DEEPGRAM_API_KEY = "stub-key";
process.env.NODE_ENV = "test";

const TRANSCRIPT = "The patient reports a persistent headache with light sensitivity for three weeks.";
let paid = false;
let listenCalls = [];
let sentBodies = [];

mock.module("@google/genai", {
  namedExports: {
    Type: { OBJECT: "OBJECT", STRING: "STRING", ARRAY: "ARRAY", NUMBER: "NUMBER" },
    GoogleGenAI: class {
      constructor() {
        this.models = {
          generateContent: async (params) => {
            const schema = params?.config?.responseSchema;
            if (!schema) return { text: "Persistent headache review" };
            return {
              text: JSON.stringify(
                Object.fromEntries(Object.keys(schema.properties).map((key) => [key, `<p>${key}</p>`]))
              ),
            };
          },
          embedContent: async ({ contents }) => ({
            embeddings: contents.map(() => ({ values: new Array(768).fill(0.01) })),
          }),
        };
      }
    },
  },
});

mock.module("../services/entitlementService.js", {
  namedExports: {
    getUserEntitlements: async () => ({ paid }),
    getRoomEntitlements: async () => ({ paid }),
    isFreeSessionLimitExceeded: () => false,
    FREE_SOAP_TRANSCRIPT_LIMIT: 3,
    isPaidSubscriber: () => paid,
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.includes("api.deepgram.com/v1/listen")) {
    listenCalls.push({ url: href, contentType: init.headers["Content-Type"] });
    sentBodies.push(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        metadata: { duration: 6.29 },
        results: { channels: [{ alternatives: [{ transcript: TRANSCRIPT, languages: ["en"] }] }] },
      }),
    };
  }
  return realFetch(url, init);
};

const { default: mongoose } = await import("mongoose");
const { User } = await import("../models/user.js");
const { Meeting } = await import("../models/meeting.js");
const { MeetingSession } = await import("../models/meetingSession.js");
const { Transcript } = await import("../models/transcript.js");
const { SoapNote } = await import("../models/soapNote.js");
const { isEncrypted } = await import("../utils/fieldCipher.js");
const { ingestRecording, getRecordingQuota, FREE_UPLOAD_LIMIT } = await import("../controllers/recordingController.js");
const { isAcceptedRecordingType } = await import("../services/recordingIngestService.js");

await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.dropDatabase();

const provider = await User.create({
  email: "rec@example.test",
  firstName: "Rec",
  role: "provider",
  status: "active",
});

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(["PASS", name]);
  } catch (err) {
    results.push(["FAIL", `${name} :: ${err.message}`]);
  }
};

function call(handler, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = { headers, body, user: provider };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, data: payload });
        return this;
      },
    };
    handler(req, res).catch((err) => resolve({ status: 500, data: { error: err.message } }));
  });
}

const audio = Buffer.from("fake-mp3-bytes-for-the-stub");

check("accepted file types cover browser recordings and common uploads", () => {
  for (const type of ["audio/webm", "audio/mpeg", "audio/mp4", "audio/wav", "video/mp4", "video/quicktime"]) {
    assert.ok(isAcceptedRecordingType(type), `${type} should be accepted`);
  }
  assert.ok(isAcceptedRecordingType("audio/webm;codecs=opus"), "codec parameters must be tolerated");
  assert.ok(!isAcceptedRecordingType("application/pdf"), "a PDF must be refused");
  assert.ok(!isAcceptedRecordingType(""), "a missing type must be refused");
});

// ---- voice visit ----
const voice = await call(ingestRecording, {
  headers: { "content-type": "audio/webm", "x-recording-kind": "voice_visit", "x-recording-language": "auto" },
  body: audio,
});

check("a voice visit produces a documented visit", () => {
  assert.equal(voice.status, 200, JSON.stringify(voice.data));
  assert.ok(voice.data.sessionId, "no session was created");
  assert.equal(voice.data.durationSeconds, 6);
  assert.ok(voice.data.note, "no SOAP note was created");
});

check("the auto title is generated for a voice visit", () => {
  assert.equal(voice.data.title, "Persistent headache review");
});

check("the detected language drives the note", () => {
  assert.equal(voice.data.language, "en");
});

const voiceMeeting = await Meeting.findOne({ _id: voice.data.meetingId }).lean();
check("the visit is marked as a voice visit", () => {
  assert.equal(voiceMeeting.source, "voice_visit");
  assert.ok(voiceMeeting.roomId.startsWith("rec-"), "recordings get their own room id");
});

const voiceTranscript = await Transcript.collection.findOne({ roomId: voiceMeeting.roomId });
check("PHI: the transcript is encrypted at rest", () => {
  assert.ok(isEncrypted(voiceTranscript.text), "transcript stored as plaintext");
  assert.ok(!String(voiceTranscript.text).includes("headache"), "plaintext leaked into storage");
});

const collections = await mongoose.connection.db.listCollections().toArray();
const audioHex = audio.toString("hex");
let audioFound = false;
for (const { name } of collections) {
  const docs = await mongoose.connection.db.collection(name).find({}).toArray();
  const blob = JSON.stringify(docs);
  if (blob.includes(audioHex) || blob.includes(audio.toString("base64"))) audioFound = true;
}
check("PHI: the recording bytes are nowhere in the database", () => {
  assert.equal(audioFound, false, "recording audio was persisted");
});

check("the transcript was sent to Deepgram with the right content type", () => {
  assert.equal(listenCalls[0].contentType, "audio/webm");
  assert.ok(listenCalls[0].url.includes("model=nova-3-medical"));
  assert.ok(listenCalls[0].url.includes("language=multi"));
  assert.equal(sentBodies[0], audio, "the raw buffer should be forwarded as-is");
});

// ---- a chosen language overrides auto-detect ----
listenCalls = [];
await call(ingestRecording, {
  headers: { "content-type": "audio/mpeg", "x-recording-kind": "upload", "x-recording-language": "zh" },
  body: audio,
});
check("a non-medical language falls back to the general model", () => {
  assert.ok(listenCalls[0].url.includes("model=nova-3"), listenCalls[0].url);
  assert.ok(!listenCalls[0].url.includes("nova-3-medical"));
  assert.ok(listenCalls[0].url.includes("language=zh"));
});

// ---- rejections ----
const wrongType = await call(ingestRecording, {
  headers: { "content-type": "application/pdf", "x-recording-kind": "upload" },
  body: audio,
});
check("a non-media upload is refused with 415", () => {
  assert.equal(wrongType.status, 415);
});

const emptyBody = await call(ingestRecording, {
  headers: { "content-type": "audio/webm", "x-recording-kind": "upload" },
  body: Buffer.alloc(0),
});
check("an empty recording is refused", () => {
  assert.equal(emptyBody.status, 400);
});

// ---- free upload limit ----
let uploads = await Meeting.countDocuments({ createdBy: provider._id, source: "upload" });
while (uploads < FREE_UPLOAD_LIMIT) {
  await call(ingestRecording, {
    headers: { "content-type": "audio/mpeg", "x-recording-kind": "upload" },
    body: audio,
  });
  uploads = await Meeting.countDocuments({ createdBy: provider._id, source: "upload" });
}

listenCalls = [];
const blocked = await call(ingestRecording, {
  headers: { "content-type": "audio/mpeg", "x-recording-kind": "upload" },
  body: audio,
});
check("GATING: a free account is cut off after three uploads", () => {
  assert.equal(blocked.status, 402, JSON.stringify(blocked.data));
  assert.equal(blocked.data.code, "upload_limit_reached");
  assert.equal(listenCalls.length, 0, "a paid transcription ran past the free limit");
});

const quota = await call(getRecordingQuota, {});
check("the quota endpoint reports the limit honestly", () => {
  assert.equal(quota.data.uploadLimit, FREE_UPLOAD_LIMIT);
  assert.equal(quota.data.uploadsRemaining, 0);
  assert.equal(quota.data.paid, false);
});

const voiceAfterLimit = await call(ingestRecording, {
  headers: { "content-type": "audio/webm", "x-recording-kind": "voice_visit" },
  body: audio,
});
check("a voice visit still works once uploads are exhausted", () => {
  assert.equal(voiceAfterLimit.status, 200, JSON.stringify(voiceAfterLimit.data));
});

// ---- deleting an upload must not refund the allowance ----
const anUpload = await Meeting.findOne({ createdBy: provider._id, source: "upload" });
await Meeting.softDelete({ _id: anUpload._id }, { actorId: provider._id, reason: "test" });
const afterDelete = await call(getRecordingQuota, {});
check("GATING: deleting an upload does not restore the allowance", () => {
  assert.equal(afterDelete.data.uploadsRemaining, 0, "the free limit could be reset by deleting");
});

// ---- paid accounts ----
paid = true;
const paidQuota = await call(getRecordingQuota, {});
check("a paid account reports no upload limit", () => {
  assert.equal(paidQuota.data.uploadLimit, null);
  assert.equal(paidQuota.data.uploadsRemaining, null);
});

const paidUpload = await call(ingestRecording, {
  headers: { "content-type": "audio/mpeg", "x-recording-kind": "upload" },
  body: audio,
});
check("a paid account can upload past three", () => {
  assert.equal(paidUpload.status, 200, JSON.stringify(paidUpload.data));
});

const notes = await SoapNote.countDocuments({ createdBy: provider._id });
const sessions = await MeetingSession.countDocuments({ createdBy: provider._id });
check("every processed recording left a session and a note", () => {
  assert.ok(notes >= 5, `expected notes, found ${notes}`);
  assert.ok(sessions >= 5, `expected sessions, found ${sessions}`);
});

await mongoose.disconnect();
const failures = results.filter(([status]) => status === "FAIL");
for (const [status, name] of results) console.log(`${status === "PASS" ? "✔" : "✖"} ${name}`);
console.log(`\n${results.length - failures.length}/${results.length} passed`);
process.exit(failures.length ? 1 : 0);
