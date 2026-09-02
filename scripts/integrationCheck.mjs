// Drives the real HTTP API against a running server. Verifies wiring, not units.
import assert from "node:assert/strict";
import mongoose from "mongoose";

const BASE = "http://127.0.0.1:5001/api";
const results = [];
const check = (n, f) =>
  Promise.resolve()
    .then(f)
    .then(() => results.push(["PASS", n]))
    .catch((e) => results.push(["FAIL", `${n} :: ${e.message}`]));

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
    has: (k) => cookies.has(k),
    clear: () => cookies.clear(),
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
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

await mongoose.connect("mongodb://127.0.0.1:27778/cb_k1");
const db = mongoose.connection.db;
const { generateTotpCode } = await import("../utils/totp.js");

const provider = jar();
const adminJar = jar();
let providerId, adminId, roomId, meetingId, sessionId, adminSecret;

/* ---------------- auth ---------------- */

await check("POST /auth/signup creates an unverified provider", async () => {
  const { status, data } = await call(provider, "POST", "/auth/signup", {
    firstName: "Dana", email: "dana@clinic.test", password: "correct-horse-battery",
  });
  assert.equal(status, 200);
  assert.equal(data.requiresVerification, true);
  const user = await db.collection("users").findOne({ email: "dana@clinic.test" });
  assert.equal(user.role, "provider", "signup must never mint an admin");
  assert.equal(user.status, "active");
  providerId = user._id;
});

await check("signup cannot smuggle in a role or adminCode", async () => {
  await call(provider, "POST", "/auth/signup", {
    firstName: "Mal", email: "mal@clinic.test", password: "correct-horse-battery",
    role: "admin", adminCode: "anything",
  });
  const user = await db.collection("users").findOne({ email: "mal@clinic.test" });
  assert.equal(user.role, "provider");
});

await check("unverified login is refused a session", async () => {
  const { data } = await call(provider, "POST", "/auth/login", {
    email: "dana@clinic.test", password: "correct-horse-battery",
  });
  assert.equal(data.requiresVerification, true);
  assert.equal(provider.has("cb_access"), false, "no session cookie before verification");
});

await check("POST /auth/login issues a session once verified", async () => {
  await db.collection("users").updateOne({ _id: providerId }, { $set: { verified: true } });
  const { status, data } = await call(provider, "POST", "/auth/login", {
    email: "dana@clinic.test", password: "correct-horse-battery",
  });
  assert.equal(status, 200);
  assert.equal(data.user.email, "dana@clinic.test");
  assert.ok(provider.has("cb_access") && provider.has("cb_refresh"));
  // Secrets must never appear in a response body.
  const blob = JSON.stringify(data);
  assert.ok(!blob.includes("password") || !blob.includes("pbkdf2"));
  assert.equal(data.user.mfa, undefined);
});

await check("wrong password is rejected", async () => {
  const throwaway = jar();
  const { status } = await call(throwaway, "POST", "/auth/login", {
    email: "dana@clinic.test", password: "wrong-password",
  });
  assert.equal(status, 400);
  assert.equal(throwaway.has("cb_access"), false);
});

await check("GET /auth/me returns the session user", async () => {
  const { status, data } = await call(provider, "GET", "/auth/me");
  assert.equal(status, 200);
  assert.equal(data.user.email, "dana@clinic.test");
  assert.equal(data.user.isActive, true);
});

await check("GET /auth/me without cookies is 401", async () => {
  const { status } = await call(jar(), "GET", "/auth/me");
  assert.equal(status, 401);
});

await check("POST /auth/refresh rotates the session", async () => {
  const { status, data } = await call(provider, "POST", "/auth/refresh");
  assert.equal(status, 200);
  assert.equal(data.user.email, "dana@clinic.test");
});

/* ---------------- provider workflow ---------------- */

await check("POST /dashboard/meetings creates a meeting", async () => {
  const { status, data } = await call(provider, "POST", "/dashboard/meetings", {
    title: "Consult: Jane Doe", description: "Cardiology follow-up",
  });
  assert.equal(status, 200);
  assert.equal(data.meeting.title, "Consult: Jane Doe");
  roomId = data.meeting.roomId;
  meetingId = data.meeting.meetingId || data.meeting._id;
});

await check("meeting title is ciphertext in the database", async () => {
  const raw = await db.collection("meetings").findOne({ roomId });
  assert.ok(raw.title.startsWith("enc.v1."), "title must be encrypted at rest");
  assert.ok(!JSON.stringify(raw).includes("Jane Doe"));
});

await check("GET /dashboard/meetings/:id returns the title decrypted", async () => {
  // The list endpoint returns sessions, and a scheduled meeting has none until
  // the call starts, so fetch it by id instead.
  const { status, data } = await call(provider, "GET", `/dashboard/meetings/${meetingId}`);
  assert.equal(status, 200);
  const title = data.meeting?.title || data.session?.title || JSON.stringify(data);
  assert.ok(title.includes("Consult: Jane Doe"), `expected decrypted title, got ${title}`);
});

await check("POST notes and private-notes round-trip through the API", async () => {
  const list = await call(provider, "GET", "/notes/meetings");
  sessionId = meetingId;

  const note = await call(provider, "POST", `/dashboard/meetings/${meetingId}/notes`, {
    content: { subjective: "<p>Chest pain, 3 days</p>", plan: "<p>ECG for Jane Doe</p>" },
  });
  assert.equal(note.status, 200);

  const priv = await call(provider, "POST", `/dashboard/meetings/${meetingId}/private-notes`, {
    content: "Private impression about Jane Doe",
  });
  assert.equal(priv.status, 200);

  const back = await call(provider, "GET", `/dashboard/meetings/${meetingId}/private-notes`);
  assert.equal(back.status, 200);
  assert.ok(JSON.stringify(back.data).includes("Private impression about Jane Doe"));
});

await check("no plaintext PHI anywhere in the clinical collections", async () => {
  for (const c of ["meetings", "soapnotes", "privatenotes", "transcripts", "meetingsessions"]) {
    const docs = await db.collection(c).find({}).toArray();
    const blob = JSON.stringify(docs);
    assert.ok(!blob.includes("Jane Doe"), `${c} leaked a patient name`);
    assert.ok(!blob.includes("Chest pain"), `${c} leaked clinical content`);
  }
});

await check("another provider cannot read the first one's meeting", async () => {
  const other = jar();
  await call(other, "POST", "/auth/signup", {
    firstName: "Eve", email: "eve@clinic.test", password: "correct-horse-battery",
  });
  await db.collection("users").updateOne({ email: "eve@clinic.test" }, { $set: { verified: true } });
  await call(other, "POST", "/auth/login", { email: "eve@clinic.test", password: "correct-horse-battery" });
  const { status } = await call(other, "GET", `/dashboard/meetings/${meetingId}`);
  assert.equal(status, 403, "cross-tenant read must be forbidden");
});

/* ---------------- admin + MFA ---------------- */

await check("admin routes reject a provider", async () => {
  const { status } = await call(provider, "GET", "/admin/dashboard");
  assert.equal(status, 403);
});

await check("an admin without MFA is blocked from admin routes", async () => {
  await db.collection("users").updateOne(
    { email: "mal@clinic.test" },
    { $set: { role: "admin", verified: true, status: "active" } }
  );
  const { status, data } = await call(adminJar, "POST", "/auth/login", {
    email: "mal@clinic.test", password: "correct-horse-battery",
  });
  assert.equal(status, 200);
  const admin = await db.collection("users").findOne({ email: "mal@clinic.test" });
  adminId = admin._id;

  const blocked = await call(adminJar, "GET", "/admin/dashboard");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, "mfa_enrollment_required");
});

await check("MFA enrolment returns a secret and QR, then unlocks admin routes", async () => {
  const enroll = await call(adminJar, "POST", "/auth/mfa/enroll");
  assert.equal(enroll.status, 200);
  assert.ok(enroll.data.qrSvg.includes("<svg"));
  adminSecret = enroll.data.secret;

  const bad = await call(adminJar, "POST", "/auth/mfa/confirm", { code: "000000" });
  assert.equal(bad.status, 400, "a wrong code must not enrol");

  const good = await call(adminJar, "POST", "/auth/mfa/confirm", { code: generateTotpCode(adminSecret) });
  assert.equal(good.status, 200);
  assert.equal(good.data.recoveryCodes.length, 10);

  const dash = await call(adminJar, "GET", "/admin/dashboard");
  assert.equal(dash.status, 200);
  assert.ok(Array.isArray(dash.data.users));
});

await check("the stored MFA secret is encrypted and never returned by /auth/me", async () => {
  const raw = await db.collection("users").findOne({ _id: adminId });
  assert.ok(raw.mfa.secret.startsWith("enc.v1."));
  const me = await call(adminJar, "GET", "/auth/me");
  assert.equal(me.data.user.mfa, undefined);
  assert.equal(me.data.user.mfaEnabled, true);
});

await check("login now demands the second factor and issues no session first", async () => {
  const fresh = jar();
  const { status, data } = await call(fresh, "POST", "/auth/login", {
    email: "mal@clinic.test", password: "correct-horse-battery",
  });
  assert.equal(status, 200);
  assert.equal(data.requiresMfa, true);
  assert.equal(data.user, undefined);
  assert.equal(fresh.has("cb_access"), false, "no access cookie before MFA clears");
  assert.equal(fresh.has("cb_mfa"), true);

  // The half-authenticated cookie must not satisfy requireAuth.
  const probe = await call(fresh, "GET", "/auth/me");
  assert.equal(probe.status, 401);

  const wrong = await call(fresh, "POST", "/auth/mfa/verify", { code: "000000" });
  assert.equal(wrong.status, 400);

  await db.collection("users").updateOne({ _id: adminId }, { $unset: { "mfa.lastUsedStep": 1 } });
  const ok = await call(fresh, "POST", "/auth/mfa/verify", { code: generateTotpCode(adminSecret) });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.email, "mal@clinic.test");
  assert.equal(fresh.has("cb_access"), true);
});

/* ---------------- deactivation ---------------- */

await check("POST /admin/users/:id/deactivate kills the target's live session", async () => {
  const before = await call(provider, "GET", "/auth/me");
  assert.equal(before.status, 200);

  const { status, data } = await call(adminJar, "POST", `/admin/users/${providerId}/deactivate`, {
    reason: "Left the practice",
  });
  assert.equal(status, 200);
  assert.ok(data.message.includes("deactivated"));

  const after = await call(provider, "GET", "/auth/me");
  assert.equal(after.status, 403, "an existing session must stop working immediately");
  assert.equal(after.data.code, "account_deactivated");
});

await check("a deactivated user cannot log back in or refresh", async () => {
  const fresh = jar();
  const login = await call(fresh, "POST", "/auth/login", {
    email: "dana@clinic.test", password: "correct-horse-battery",
  });
  assert.equal(login.status, 403);

  const refresh = await call(provider, "POST", "/auth/refresh");
  assert.ok([401, 403].includes(refresh.status));
});

await check("their room link stops admitting patients", async () => {
  const { status } = await call(jar(), "GET", `/public/meetings/${roomId}`);
  assert.equal(status, 404);
});

await check("their clinical records still exist", async () => {
  assert.ok(await db.collection("meetings").countDocuments({ createdBy: providerId }) > 0);
  assert.ok(await db.collection("soapnotes").countDocuments({}) > 0);
});

await check("reactivation restores access", async () => {
  const { status } = await call(adminJar, "POST", `/admin/users/${providerId}/reactivate`);
  assert.equal(status, 200);
  const fresh = jar();
  const login = await call(fresh, "POST", "/auth/login", {
    email: "dana@clinic.test", password: "correct-horse-battery",
  });
  assert.equal(login.status, 200);
  const pub = await call(jar(), "GET", `/public/meetings/${roomId}`);
  assert.equal(pub.status, 200);
});

await check("an admin cannot deactivate themselves", async () => {
  const { status, data } = await call(adminJar, "POST", `/admin/users/${adminId}/deactivate`, {
    reason: "testing self deactivation guard",
  });
  assert.equal(status, 400);
  assert.ok(/own account/.test(data.error));
});

/* ---------------- break-glass ---------------- */

await check("break-glass rejects a thin reason and a bad code", async () => {
  const thin = await call(adminJar, "POST", "/admin/break-glass", {
    targetUserId: String(providerId), reason: "need", code: generateTotpCode(adminSecret),
  });
  assert.equal(thin.status, 400);

  const badCode = await call(adminJar, "POST", "/admin/break-glass", {
    targetUserId: String(providerId), reason: "Records request for a departed clinician", code: "000000",
  });
  assert.equal(badCode.status, 400);
});

await check("a valid grant returns the provider's records", async () => {
  await db.collection("users").updateOne({ _id: adminId }, { $unset: { "mfa.lastUsedStep": 1 } });
  const open = await call(adminJar, "POST", "/admin/break-glass", {
    targetUserId: String(providerId),
    reason: "Patient records request #4821 for a departed clinician",
    code: generateTotpCode(adminSecret),
  });
  assert.equal(open.status, 200);

  const records = await call(adminJar, "GET", `/admin/break-glass/${open.data.grant._id}/records`);
  assert.equal(records.status, 200);
  assert.ok(records.data.meetings.some((m) => m.title === "Consult: Jane Doe"));
  assert.ok(records.data.soapNotes.length > 0);
  assert.ok(records.data.privateNotes.some((n) => n.content.includes("Jane Doe")));
});

await check("a provider cannot reach break-glass at all", async () => {
  const fresh = jar();
  await call(fresh, "POST", "/auth/login", { email: "dana@clinic.test", password: "correct-horse-battery" });
  const { status } = await call(fresh, "POST", "/admin/break-glass", {
    targetUserId: String(adminId), reason: "trying to escalate privileges here", code: "123456",
  });
  assert.equal(status, 403);
});

/* ---------------- compliance + audit ---------------- */

await check("GET /admin/compliance reports jobs and retention", async () => {
  const { status, data } = await call(adminJar, "GET", "/admin/compliance");
  assert.equal(status, 200);
  assert.equal(data.jobs.length, 2);
  assert.ok(data.retention.retentionDays >= 2191);
  assert.ok(data.retention.rows.length >= 5);
});

await check("GET /admin/audit-logs paginates", async () => {
  const { status, data } = await call(adminJar, "GET", "/admin/audit-logs?limit=5");
  assert.equal(status, 200);
  assert.equal(data.logs.length <= 5, true);
  assert.ok(data.total > 0);
});

await check("privileged actions are attributable to a real user id", async () => {
  const entry = await db.collection("auditlogs").findOne({ path: /break-glass/ });
  assert.ok(entry, "break-glass access must be audited");
  assert.ok(entry.actorUserId, "actor must be a real ObjectId, not env-admin");
  assert.equal(String(entry.actorUserId), String(adminId));
});

await check("the audit chain is intact after the whole run", async () => {
  const { verifyAuditChain } = await import("../services/auditLogService.js");
  const result = await verifyAuditChain();
  assert.equal(result.ok, true, JSON.stringify(result.problems?.slice(0, 3)));
  assert.ok(result.checked > 20, `expected a populated chain, got ${result.checked}`);
});

await check("audit logs never capture request bodies", async () => {
  const logs = await db.collection("auditlogs").find({}).toArray();
  const blob = JSON.stringify(logs);
  assert.ok(!blob.includes("correct-horse-battery"), "passwords must never reach the audit log");
  assert.ok(!blob.includes("Jane Doe"), "PHI must never reach the audit log");
  assert.ok(!blob.includes(adminSecret), "MFA secrets must never reach the audit log");
});

await mongoose.disconnect();
const failures = results.filter(([s]) => s === "FAIL");
for (const [s, n] of results) console.log(`${s === "PASS" ? "✔" : "✖"} ${n}`);
console.log(`\n${results.length - failures.length}/${results.length} passed`);
process.exit(failures.length ? 1 : 0);
