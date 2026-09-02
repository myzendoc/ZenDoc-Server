import assert from "node:assert/strict";
import test from "node:test";
import { AuthSession } from "../models/authSession.js";
import { parseCookies, serializeCookie } from "../utils/cookies.js";
import { signToken, verifyToken } from "../utils/jwt.js";
import { isAllowedOrigin } from "../utils/origins.js";
import { getMeetingRole, isMeetingCreatorJoin } from "../utils/socketAuth.js";

test("access JWT defaults to a short lifetime", () => {
  const token = signToken({ sub: "user-1", typ: "access" }, "test-secret");
  const payload = verifyToken(token, "test-secret");
  assert.equal(payload.sub, "user-1");
  assert.ok(payload.exp - payload.iat <= 10 * 60);
});

test("authentication cookies carry browser security attributes", () => {
  const cookie = serializeCookie("cb_access", "secret", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60_000,
  });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.equal(parseCookies("one=1; cb_access=hello%20world").cb_access, "hello world");
});

test("session refresh hashes are excluded from normal model reads", () => {
  assert.equal(AuthSession.schema.path("refreshTokenHash").options.select, false);
  const ttlIndex = AuthSession.schema.indexes().find(([fields]) => fields.absoluteExpiresAt === 1);
  assert.ok(ttlIndex);
  assert.equal(ttlIndex[1].expireAfterSeconds, 0);
});

test("only configured application origins are accepted", () => {
  assert.equal(isAllowedOrigin("https://myzendoc.com"), true);
  assert.equal(isAllowedOrigin("https://attacker.example"), false);
});

test("meeting roles come from server-authenticated identity", () => {
  const meeting = { createdBy: "provider-1" };
  assert.equal(isMeetingCreatorJoin(meeting, { userId: "provider-1", role: "provider" }), true);
  assert.equal(getMeetingRole(meeting, { userId: "provider-1", role: "provider" }).role, "creator");
  assert.equal(getMeetingRole(meeting, { userId: "patient-1", role: "provider" }).role, "guest");
  assert.equal(isMeetingCreatorJoin(meeting, { userId: "admin-1", role: "admin" }), false);
  assert.equal(getMeetingRole(meeting, { userId: "admin-1", role: "admin" }).role, "guest");
});
