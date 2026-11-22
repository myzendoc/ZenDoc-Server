// HTTP checks for the Ask routes against a running server. Logs in a
// pre-verified user so no mail is sent.
// Run: node scripts/askRouteCheck.mjs   (server on 5001, mongo on 27778)
import assert from "node:assert/strict";
import mongoose from "mongoose";

const BASE = process.env.ASK_CHECK_BASE || "http://127.0.0.1:5001/api";
const MONGO = process.env.ASK_CHECK_MONGO || "mongodb://127.0.0.1:27778/cb_fin2";
const PASSWORD = "correct-horse-battery";

const results = [];
const check = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => results.push(["PASS", name]))
    .catch((err) => results.push(["FAIL", `${name} :: ${err.message}`]));

function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(";");
        const i = pair.indexOf("=");
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (!v) cookies.delete(k);
        else cookies.set(k, v);
      }
    },
  };
}

async function call(cookieJar, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookieJar.header() },
    body: body ? JSON.stringify(body) : undefined,
  });
  cookieJar.absorb(res);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

await mongoose.connect(MONGO);
const { hashPasswordForScript } = await import("../services/userService.js");
const { User } = await import("../models/user.js");
const { Meeting } = await import("../models/meeting.js");
const { AuditLog } = await import("../models/auditLog.js");

const stamp = Date.now();
async function seedVerifiedProvider(email) {
  return User.create({
    firstName: email.split("@")[0],
    email,
    password: hashPasswordForScript(PASSWORD),
    role: "provider",
    status: "active",
    verified: true,
    onboardingComplete: true,
  });
}

const alice = await seedVerifiedProvider(`ask-alice-${stamp}@clinic.test`);
const mallory = await seedVerifiedProvider(`ask-mallory-${stamp}@clinic.test`);

const aliceJar = jar();
const malloryJar = jar();
const anon = jar();

await check("login issues a session without sending mail", async () => {
  const { status, data } = await call(aliceJar, "POST", "/auth/login", {
    email: alice.email,
    password: PASSWORD,
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.user, "no user in the login response");
});

await call(malloryJar, "POST", "/auth/login", { email: mallory.email, password: PASSWORD });

await check("GET /ask/status requires authentication", async () => {
  const { status } = await call(anon, "GET", "/ask/status");
  assert.equal(status, 401);
});

await check("POST /ask requires authentication", async () => {
  const { status } = await call(anon, "POST", "/ask", { question: "anything" });
  assert.equal(status, 401);
});

await check("POST /ask/meeting requires authentication", async () => {
  const { status } = await call(anon, "POST", `/ask/meeting/${new mongoose.Types.ObjectId()}`, {
    question: "anything",
  });
  assert.equal(status, 401);
});

await check("GET /ask/status reports an empty index for a new provider", async () => {
  const { status, data } = await call(aliceJar, "GET", "/ask/status");
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.indexedChunks, 0);
  assert.equal(data.indexedVisits, 0);
  assert.equal(typeof data.configured, "boolean");
});

await check("POST /ask rejects a blank question before any model call", async () => {
  const { status, data } = await call(aliceJar, "POST", "/ask", { question: "   " });
  assert.equal(status, 400, JSON.stringify(data));
  assert.equal(data.error, "Ask a question first");
});

await check("POST /ask rejects a missing body", async () => {
  const { status } = await call(aliceJar, "POST", "/ask", {});
  assert.equal(status, 400);
});

const aliceMeeting = await Meeting.create({
  roomId: `ask-room-${stamp}`,
  createdBy: alice._id,
  startedAt: new Date(),
});

await check("a provider's own meeting passes the ownership gate", async () => {
  const { status, data } = await call(aliceJar, "POST", `/ask/meeting/${aliceMeeting._id}`, {
    question: "What was discussed?",
  });
  assert.notEqual(status, 404, "the owner was refused their own meeting");
  assert.notEqual(status, 403, "the owner was refused their own meeting");
  assert.notEqual(data.error, "Meeting not found");
  // 200 with real credentials, 502 when the model is unreachable in this harness.
  assert.ok([200, 502].includes(status), `unexpected status ${status}: ${JSON.stringify(data)}`);
});

await check("CROSS-TENANT: another provider is refused that meeting", async () => {
  const { status, data } = await call(malloryJar, "POST", `/ask/meeting/${aliceMeeting._id}`, {
    question: "What was discussed?",
  });
  assert.equal(status, 404, JSON.stringify(data));
  assert.equal(data.error, "Meeting not found");
  assert.ok(!JSON.stringify(data).includes(aliceMeeting.roomId), "the response leaked the room id");
});

await check("an unknown meeting id is a 404, not a server error", async () => {
  const { status } = await call(aliceJar, "POST", `/ask/meeting/${new mongoose.Types.ObjectId()}`, {
    question: "test",
  });
  assert.equal(status, 404);
});

await check("a malformed meeting id does not 500", async () => {
  const { status } = await call(aliceJar, "POST", "/ask/meeting/not-an-object-id", { question: "test" });
  assert.equal(status, 404, "a bad id should resolve to not-found");
});

await check("ask requests land in the audit trail attributed to the caller", async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const entry = await AuditLog.findOne({ path: /ask\/status/, actorUserId: alice._id }).lean();
  assert.ok(entry, "no audit entry for the ask status request");
  assert.equal(entry.actorRole, "provider");
});

await check("the refused cross-tenant attempt is recorded as a failure", async () => {
  const entries = await AuditLog.find({ actorUserId: mallory._id, path: /ask/ }).lean();
  assert.ok(entries.length > 0, "the attempt was not audited");
  assert.ok(
    entries.some((entry) => entry.status === "failure"),
    "a refused PHI request must be audited as a failure"
  );
});

await User.deleteMany({ _id: { $in: [alice._id, mallory._id] } });
await Meeting.deleteOne({ _id: aliceMeeting._id });
await mongoose.disconnect();

const failures = results.filter(([status]) => status === "FAIL");
for (const [status, name] of results) console.log(`${status === "PASS" ? "✔" : "✖"} ${name}`);
console.log(`\n${results.length - failures.length}/${results.length} passed`);
process.exit(failures.length ? 1 : 0);
