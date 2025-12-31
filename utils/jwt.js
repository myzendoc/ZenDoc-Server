import crypto from "crypto";

const DEFAULT_EXPIRY = 60 * 60 * 24 * 7;

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString();
}

export function signToken(payload, secret, expiresInSeconds = DEFAULT_EXPIRY) {
  if (!secret) throw new Error("JWT secret missing");
  const header = { alg: "HS256", typ: "JWT" };
  const issuedAt = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: issuedAt };
  if (expiresInSeconds) {
    body.exp = issuedAt + expiresInSeconds;
  }
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(body));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(unsignedToken)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${unsignedToken}.${signature}`;
}

export function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const unsignedToken = `${parts[0]}.${parts[1]}`;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(unsignedToken)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  if (expectedSignature.length !== parts[2].length) return null;
  try {
    const valid = crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(parts[2]));
    if (!valid) return null;
  } catch (err) {
    return null;
  }
  const payload = JSON.parse(base64UrlDecode(parts[1]));
  if (payload?.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}
