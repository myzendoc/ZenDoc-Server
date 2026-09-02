import crypto from "crypto";

// RFC 6238 TOTP over RFC 4226 HOTP.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIGITS = 6;
const PERIOD_SECONDS = 30;
const SECRET_BYTES = 20;
// One step either side absorbs clock drift between the server and the phone.
const DEFAULT_WINDOW = 1;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 5;

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const normalized = String(input || "").toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character in TOTP secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", secretBuffer).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function generateTotpCode(secret, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  return hotp(base32Decode(secret), counter);
}

export function verifyTotpCode(secret, code, { atMs = Date.now(), window = DEFAULT_WINDOW } = {}) {
  const candidate = String(code || "").replace(/\s/g, "");
  if (!secret || !/^\d{6}$/.test(candidate)) return null;

  let secretBuffer;
  try {
    secretBuffer = base32Decode(secret);
  } catch {
    return null;
  }

  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  for (let drift = -window; drift <= window; drift += 1) {
    const step = counter + drift;
    if (step < 0) continue;
    const expected = hotp(secretBuffer, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) {
      // Returning the step lets the caller reject a replayed code.
      return { step };
    }
  }
  return null;
}

export function buildOtpauthUri({ secret, accountName, issuer = "ZenDoc" }) {
  // Separator stays a literal colon per the otpauth format.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(RECOVERY_CODE_BYTES)).slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  });
}

export function normalizeRecoveryCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
}

// High-entropy and single-use, so a fast hash is fine here.
export function hashRecoveryCode(code) {
  return crypto.createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

export { DIGITS as TOTP_DIGITS, PERIOD_SECONDS as TOTP_PERIOD_SECONDS };
