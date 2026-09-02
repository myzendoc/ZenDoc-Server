import crypto from "crypto";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function normalizeIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

function hashIdentifier(value) {
  return crypto.createHash("sha256").update(normalizeIdentifier(value)).digest("hex");
}

function ipKey(req) {
  return `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || "unknown")}`;
}

function emailKey(req) {
  const email = normalizeIdentifier(req.body?.email || req.body?.newEmail);
  return email ? `email:${hashIdentifier(email)}` : ipKey(req);
}

function userKey(req) {
  const userId = normalizeIdentifier(req.user?._id || req.user?.id);
  return userId ? `user:${userId}` : ipKey(req);
}

export function createRequestLimiter({ name, windowMs, limit, keyGenerator = ipKey, skipSuccessfulRequests = false }) {
  return rateLimit({
    identifier: name,
    windowMs,
    limit,
    keyGenerator,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler(_req, res) {
      res.status(429).json({ error: "Too many requests. Try again later." });
    },
  });
}

export const signupRateLimit = createRequestLimiter({
  name: "signup",
  windowMs: ONE_HOUR_MS,
  limit: 5,
});

export const loginRateLimit = createRequestLimiter({
  name: "login",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 10,
});

export const otpSendRateLimit = createRequestLimiter({
  name: "otp-send",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 3,
  keyGenerator: emailKey,
});

export const otpVerifyRateLimit = createRequestLimiter({
  name: "otp-verify",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 8,
  keyGenerator: emailKey,
  skipSuccessfulRequests: true,
});

export const accountVerificationRateLimit = createRequestLimiter({
  name: "account-verification",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 8,
  keyGenerator: userKey,
  skipSuccessfulRequests: true,
});

export const passwordResetRequestRateLimit = createRequestLimiter({
  name: "password-reset-request",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 3,
  keyGenerator: emailKey,
});

export const passwordResetRateLimit = createRequestLimiter({
  name: "password-reset",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 8,
  keyGenerator: ipKey,
  skipSuccessfulRequests: true,
});

export const invitationRateLimit = createRequestLimiter({
  name: "invitation",
  windowMs: ONE_HOUR_MS,
  limit: 20,
  keyGenerator: userKey,
});

// Throttling is what makes a 6-digit code strong.
function mfaKey(req) {
  const userId = normalizeIdentifier(req.user?._id || req.user?.id);
  if (userId) return `user:${userId}`;
  const subject = normalizeIdentifier(req.mfaChallengeSubject);
  return subject ? `mfa:${hashIdentifier(subject)}` : ipKey(req);
}

export const mfaVerifyRateLimit = createRequestLimiter({
  name: "mfa-verify",
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 8,
  keyGenerator: mfaKey,
  skipSuccessfulRequests: true,
});

export function createInMemoryRateLimiter({ limit, windowMs }) {
  const buckets = new Map();

  return function consume(key, now = Date.now()) {
    const safeKey = hashIdentifier(key);
    const current = buckets.get(safeKey);
    if (!current || current.resetAt <= now) {
      const next = { count: 1, resetAt: now + windowMs };
      buckets.set(safeKey, next);
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    if (current.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      };
    }

    current.count += 1;
    return { allowed: true, remaining: limit - current.count, retryAfterSeconds: 0 };
  };
}

export const consumeWaitingRoomEmailLimit = createInMemoryRateLimiter({
  limit: 3,
  windowMs: FIFTEEN_MINUTES_MS,
});
