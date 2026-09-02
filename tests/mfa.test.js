import test from "node:test";
import assert from "node:assert/strict";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyTotpCode,
} from "../utils/totp.js";
import { sanitizeUser } from "../services/userService.js";

// RFC 4226 Appendix D / RFC 6238 Appendix B reference vector. The shared secret
// is the ASCII string "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

test("TOTP matches the RFC 6238 reference vectors", () => {
  // These are the published expected values for SHA-1 / 8 digits truncated to 6.
  assert.equal(generateTotpCode(RFC_SECRET, 59 * 1000), "287082");
  assert.equal(generateTotpCode(RFC_SECRET, 1111111109 * 1000), "081804");
  assert.equal(generateTotpCode(RFC_SECRET, 1234567890 * 1000), "005924");
});

test("base32 round-trips the secret an authenticator app is given", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.equal(base32Encode(base32Decode(secret)), secret);
});

test("a valid code verifies and reports the step it belongs to", () => {
  const now = 1_700_000_000_000;
  const code = generateTotpCode(RFC_SECRET, now);
  const result = verifyTotpCode(RFC_SECRET, code, { atMs: now });
  assert.ok(result);
  assert.equal(result.step, Math.floor(now / 1000 / 30));
});

test("codes are accepted one step either side to absorb clock drift", () => {
  const now = 1_700_000_000_000;
  const previous = generateTotpCode(RFC_SECRET, now - 30_000);
  const next = generateTotpCode(RFC_SECRET, now + 30_000);
  assert.ok(verifyTotpCode(RFC_SECRET, previous, { atMs: now }));
  assert.ok(verifyTotpCode(RFC_SECRET, next, { atMs: now }));
});

test("codes outside the drift window are rejected", () => {
  const now = 1_700_000_000_000;
  const stale = generateTotpCode(RFC_SECRET, now - 120_000);
  assert.equal(verifyTotpCode(RFC_SECRET, stale, { atMs: now }), null);
});

test("malformed codes are rejected without throwing", () => {
  const now = 1_700_000_000_000;
  for (const bad of ["", null, undefined, "abcdef", "12345", "1234567", { a: 1 }]) {
    assert.equal(verifyTotpCode(RFC_SECRET, bad, { atMs: now }), null);
  }
  assert.equal(verifyTotpCode("not-base32!", "123456", { atMs: now }), null);
});

test("the returned step is what lets a replayed code be refused", () => {
  const now = 1_700_000_000_000;
  const code = generateTotpCode(RFC_SECRET, now);
  const first = verifyTotpCode(RFC_SECRET, code, { atMs: now });
  const second = verifyTotpCode(RFC_SECRET, code, { atMs: now + 1000 });
  // Both verify cryptographically; the service rejects the second because the
  // step is not greater than the last one it recorded.
  assert.equal(first.step, second.step);
});

test("the otpauth URI carries the parameters an authenticator app needs", () => {
  const uri = buildOtpauthUri({ secret: RFC_SECRET, accountName: "doc@clinic.com" });
  assert.ok(uri.startsWith("otpauth://totp/ZenDoc:doc%40clinic.com?"));
  assert.ok(uri.includes(`secret=${RFC_SECRET}`));
  assert.ok(uri.includes("issuer=ZenDoc"));
  assert.ok(uri.includes("digits=6"));
  assert.ok(uri.includes("period=30"));
});

test("recovery codes are distinct, formatted, and hashed consistently", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);

  // Users retype these, so formatting and case must not affect the match.
  const [first] = codes;
  assert.equal(hashRecoveryCode(first), hashRecoveryCode(first.toLowerCase()));
  assert.equal(hashRecoveryCode(first), hashRecoveryCode(first.replace("-", " ")));
  assert.equal(normalizeRecoveryCode(first), first.replace("-", ""));
});

test("sanitizeUser never exposes the MFA secret or recovery hashes", () => {
  const result = sanitizeUser({
    email: "doc@clinic.com",
    password: "pbkdf2$210000$salt$hash",
    role: "admin",
    status: "active",
    mfa: {
      enabled: true,
      secret: "enc.v1.k1.aa.bb.cc",
      pendingSecret: "enc.v1.k1.dd.ee.ff",
      recoveryCodes: [{ hash: "deadbeef", usedAt: null }],
    },
    baa: { signed: true, signature: "data:image/png;base64,AAAA" },
  });

  assert.equal(result.mfa, undefined);
  assert.equal(result.mfaEnabled, true);
  assert.equal(result.password, undefined);
  assert.equal(result.hasPassword, true);
  // The drawn signature is an identity artifact and should not ride along on
  // every /auth/me response.
  assert.equal(result.baa.signature, undefined);
  assert.equal(result.baa.signed, true);
  assert.ok(!JSON.stringify(result).includes("deadbeef"));
  assert.ok(!JSON.stringify(result).includes("enc.v1.k1"));
});
