import crypto from "crypto";
import mongoose from "mongoose";
import { AuthSession } from "../models/authSession.js";
import { signToken, verifyToken } from "../utils/jwt.js";
import { appendSetCookie, parseCookies, serializeCookie } from "../utils/cookies.js";

export const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
export const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

const ACCESS_COOKIE = "cb_access";
const REFRESH_COOKIE = "cb_refresh";
const MFA_COOKIE = "cb_mfa";
const ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000;
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

function cookieSecure() {
  if (process.env.COOKIE_SECURE === "false") return false;
  return process.env.NODE_ENV !== "development";
}

function cookieOptions(path, maxAge) {
  return { httpOnly: true, secure: cookieSecure(), sameSite: "Lax", path, maxAge };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newRefreshToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function appendAuthCookies(res, accessToken, sessionId, refreshToken) {
  appendSetCookie(
    res,
    serializeCookie(ACCESS_COOKIE, accessToken, cookieOptions("/", ACCESS_TOKEN_TTL_SECONDS * 1000))
  );
  appendSetCookie(
    res,
    serializeCookie(
      REFRESH_COOKIE,
      `${sessionId}.${refreshToken}`,
      cookieOptions("/api/auth", SESSION_ABSOLUTE_TIMEOUT_MS)
    )
  );
}

function getSubject(user) {
  return String(user?._id || user?.id || "").trim();
}

function issueAccessToken(session) {
  return signToken(
    { sub: session.subject, role: session.role, sid: String(session._id), typ: "access" },
    process.env.JWT_SECRET,
    ACCESS_TOKEN_TTL_SECONDS
  );
}

export function renewAccessCookie(res, session) {
  appendSetCookie(
    res,
    serializeCookie(
      ACCESS_COOKIE,
      issueAccessToken(session),
      cookieOptions("/", ACCESS_TOKEN_TTL_SECONDS * 1000)
    )
  );
}

export async function establishAuthSession(res, user) {
  const subject = getSubject(user);
  if (!subject) throw new Error("Cannot create session without subject");
  const now = new Date();
  const refreshToken = newRefreshToken();
  const session = await AuthSession.create({
    subject,
    userId: mongoose.Types.ObjectId.isValid(subject) ? subject : undefined,
    role: user.role === "admin" ? "admin" : "provider",
    refreshTokenHash: hashToken(refreshToken),
    lastActivityAt: now,
    absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS),
  });
  appendAuthCookies(res, issueAccessToken(session), String(session._id), refreshToken);
  return session;
}

function readAccessToken(cookieHeader) {
  return parseCookies(cookieHeader)[ACCESS_COOKIE] || "";
}

function readRefreshCookie(cookieHeader) {
  const value = parseCookies(cookieHeader)[REFRESH_COOKIE] || "";
  const separator = value.indexOf(".");
  if (separator < 1) return null;
  return { sessionId: value.slice(0, separator), token: value.slice(separator + 1) };
}

function sessionIsActive(session, now = Date.now()) {
  if (!session || session.revokedAt) return false;
  if (new Date(session.absoluteExpiresAt).getTime() <= now) return false;
  return new Date(session.lastActivityAt).getTime() + SESSION_IDLE_TIMEOUT_MS > now;
}

async function touchSession(session) {
  const now = Date.now();
  if (new Date(session.lastActivityAt).getTime() + ACTIVITY_WRITE_INTERVAL_MS > now) return;
  session.lastActivityAt = new Date(now);
  await session.save();
}

export async function validateAuthSession(sessionId, subject, { touch = true } = {}) {
  if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) return null;
  const session = await AuthSession.findById(sessionId);
  if (!session || session.subject !== String(subject || "") || !sessionIsActive(session)) {
    if (session && !session.revokedAt) {
      session.revokedAt = new Date();
      await session.save();
    }
    return null;
  }
  if (touch) await touchSession(session);
  return session;
}

// Payload without session validation, so a revoked session can still be attributed.
export function readAccessPayload(cookieHeader) {
  return verifyToken(readAccessToken(cookieHeader), process.env.JWT_SECRET);
}

export async function authenticateAccessCookie(cookieHeader, { touch = true } = {}) {
  const token = readAccessToken(cookieHeader);
  const payload = verifyToken(token, process.env.JWT_SECRET);
  if (!payload?.sub || !payload?.sid || payload.typ !== "access") return null;
  const session = await validateAuthSession(payload.sid, payload.sub, { touch });
  if (!session) return null;
  return { payload, session };
}

export async function refreshAuthSession(cookieHeader, res) {
  const refresh = readRefreshCookie(cookieHeader);
  if (!refresh || !mongoose.Types.ObjectId.isValid(refresh.sessionId)) return null;
  const session = await AuthSession.findById(refresh.sessionId).select("+refreshTokenHash");
  if (!session || !sessionIsActive(session)) {
    if (session && !session.revokedAt) {
      session.revokedAt = new Date();
      await session.save();
    }
    return null;
  }
  if (!safeEqual(session.refreshTokenHash, hashToken(refresh.token))) {
    session.revokedAt = new Date();
    await session.save();
    return null;
  }

  const nextRefreshToken = newRefreshToken();
  session.refreshTokenHash = hashToken(nextRefreshToken);
  session.lastActivityAt = new Date();
  await session.save();
  appendAuthCookies(res, issueAccessToken(session), String(session._id), nextRefreshToken);
  return session;
}

export async function revokeSessionFromCookies(cookieHeader) {
  const access = verifyToken(readAccessToken(cookieHeader), process.env.JWT_SECRET);
  const refresh = readRefreshCookie(cookieHeader);
  const sessionId = access?.sid || refresh?.sessionId;
  if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) return null;
  return AuthSession.findOneAndUpdate(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
    { new: true }
  );
}

export async function revokeAllSessionsForSubject(subject) {
  const value = String(subject || "").trim();
  if (!value) return;
  await AuthSession.updateMany({ subject: value, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export function clearAuthCookies(res) {
  appendSetCookie(res, serializeCookie(ACCESS_COOKIE, "", cookieOptions("/", 0)));
  appendSetCookie(res, serializeCookie(REFRESH_COOKIE, "", cookieOptions("/api/auth", 0)));
}



// A half-authenticated login holds only this token.
export function issueMfaChallenge(res, user) {
  const subject = getSubject(user);
  if (!subject) throw new Error("Cannot start MFA challenge without subject");
  const token = signToken(
    { sub: subject, typ: "mfa" },
    process.env.JWT_SECRET,
    MFA_CHALLENGE_TTL_SECONDS
  );
  appendSetCookie(
    res,
    serializeCookie(MFA_COOKIE, token, cookieOptions("/api/auth", MFA_CHALLENGE_TTL_SECONDS * 1000))
  );
  return token;
}

export function readMfaChallenge(cookieHeader) {
  const token = parseCookies(cookieHeader)[MFA_COOKIE] || "";
  const payload = verifyToken(token, process.env.JWT_SECRET);
  if (!payload?.sub || payload.typ !== "mfa") return null;
  return payload;
}

export function clearMfaChallengeCookie(res) {
  appendSetCookie(res, serializeCookie(MFA_COOKIE, "", cookieOptions("/api/auth", 0)));
}
