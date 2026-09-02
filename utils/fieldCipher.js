import crypto from "crypto";

// Envelope format:
const PREFIX = "enc";
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

let cachedRegistry = null;

function b64u(buffer) {
  return buffer.toString("base64url");
}

function fromB64u(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function parseKeyRegistry() {
  const raw = String(process.env.PHI_ENCRYPTION_KEYS || "").trim();
  const keys = new Map();
  if (!raw) return { keys, activeKeyId: "" };

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator < 1) throw new Error(`PHI_ENCRYPTION_KEYS entry is malformed (expected "keyId:base64Key")`);
    const keyId = trimmed.slice(0, separator).trim();
    const material = fromB64u(trimmed.slice(separator + 1).trim().replace(/\+/g, "-").replace(/\//g, "_"));
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new Error(`PHI_ENCRYPTION_KEYS key id "${keyId}" must be 1-32 chars of [A-Za-z0-9_-]`);
    }
    if (material.length !== KEY_BYTES) {
      throw new Error(`PHI_ENCRYPTION_KEYS key "${keyId}" must decode to ${KEY_BYTES} bytes, got ${material.length}`);
    }
    if (keys.has(keyId)) throw new Error(`PHI_ENCRYPTION_KEYS contains duplicate key id "${keyId}"`);
    keys.set(keyId, material);
  }

  const configuredActive = String(process.env.PHI_ENCRYPTION_ACTIVE_KEY || "").trim();
  const activeKeyId = configuredActive || [...keys.keys()].pop() || "";
  if (activeKeyId && !keys.has(activeKeyId)) {
    throw new Error(`PHI_ENCRYPTION_ACTIVE_KEY "${activeKeyId}" is not present in PHI_ENCRYPTION_KEYS`);
  }
  return { keys, activeKeyId };
}

function getRegistry() {
  if (!cachedRegistry) cachedRegistry = parseKeyRegistry();
  return cachedRegistry;
}

// Tests and the rotation script mutate process.env between cases.
export function resetKeyRegistryCache() {
  cachedRegistry = null;
}

export function isEncryptionConfigured() {
  return getRegistry().keys.size > 0;
}

export function getActiveKeyId() {
  return getRegistry().activeKeyId;
}

export function listKeyIds() {
  return [...getRegistry().keys.keys()];
}

function requireKey(keyId) {
  const key = getRegistry().keys.get(keyId);
  if (!key) throw new Error(`No encryption key configured for key id "${keyId}"`);
  return key;
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(`${PREFIX}.${VERSION}.`);
}

// AAD binds ciphertext to its field, so it can't be moved between records.
function aadFor(context) {
  return Buffer.from(String(context || "global"), "utf8");
}

export function encryptField(value, context) {
  if (value === null || value === undefined) return value;
  const plaintext = String(value);
  if (!plaintext) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  if (!isEncryptionConfigured()) return plaintext;

  const keyId = getActiveKeyId();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, requireKey(keyId), iv);
  cipher.setAAD(aadFor(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [PREFIX, VERSION, keyId, b64u(iv), b64u(ciphertext), b64u(authTag)].join(".");
}

export function decryptField(value, context) {
  if (value === null || value === undefined) return value;
  // Records written before the encryption rollout are still plaintext.
  if (!isEncrypted(value)) return value;

  const parts = String(value).split(".");
  if (parts.length !== 6) throw new Error("Encrypted value envelope is malformed");
  const [, , keyId, iv, ciphertext, authTag] = parts;

  const decipher = crypto.createDecipheriv(ALGORITHM, requireKey(keyId), fromB64u(iv));
  decipher.setAAD(aadFor(context));
  decipher.setAuthTag(fromB64u(authTag));
  return Buffer.concat([decipher.update(fromB64u(ciphertext)), decipher.final()]).toString("utf8");
}

// Lets a list survive one unreadable record.
export function decryptFieldOrNull(value, context) {
  try {
    return decryptField(value, context);
  } catch {
    return null;
  }
}

export function encryptValues(source, context) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return source;
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      typeof value === "string" ? encryptField(value, `${context}.${key}`) : value,
    ])
  );
}

export function decryptValues(source, context) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return source;
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      typeof value === "string" ? decryptFieldOrNull(value, `${context}.${key}`) ?? "" : value,
    ])
  );
}

export function generateKeyMaterial() {
  return crypto.randomBytes(KEY_BYTES).toString("base64url");
}
