import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  decryptField,
  decryptFieldOrNull,
  decryptValues,
  encryptField,
  encryptValues,
  getActiveKeyId,
  isEncrypted,
  isEncryptionConfigured,
  listKeyIds,
  resetKeyRegistryCache,
} from "../utils/fieldCipher.js";

const KEY_A = crypto.randomBytes(32).toString("base64url");
const KEY_B = crypto.randomBytes(32).toString("base64url");

function withKeys(keys, activeKeyId, fn) {
  const previousKeys = process.env.PHI_ENCRYPTION_KEYS;
  const previousActive = process.env.PHI_ENCRYPTION_ACTIVE_KEY;
  process.env.PHI_ENCRYPTION_KEYS = keys;
  if (activeKeyId) process.env.PHI_ENCRYPTION_ACTIVE_KEY = activeKeyId;
  else delete process.env.PHI_ENCRYPTION_ACTIVE_KEY;
  resetKeyRegistryCache();
  try {
    return fn();
  } finally {
    if (previousKeys === undefined) delete process.env.PHI_ENCRYPTION_KEYS;
    else process.env.PHI_ENCRYPTION_KEYS = previousKeys;
    if (previousActive === undefined) delete process.env.PHI_ENCRYPTION_ACTIVE_KEY;
    else process.env.PHI_ENCRYPTION_ACTIVE_KEY = previousActive;
    resetKeyRegistryCache();
  }
}

test("patient transcript text is unreadable in its stored form", () => {
  withKeys(`k1:${KEY_A}`, "k1", () => {
    const plaintext = "Patient reports chest pain radiating to the left arm.";
    const stored = encryptField(plaintext, "Transcript.text");

    assert.ok(isEncrypted(stored));
    assert.ok(!stored.includes("chest pain"));
    assert.ok(!stored.includes("Patient"));
    assert.equal(decryptField(stored, "Transcript.text"), plaintext);
  });
});

test("the same plaintext encrypts differently every time", () => {
  withKeys(`k1:${KEY_A}`, "k1", () => {
    const first = encryptField("Diagnosis: hypertension", "SoapNote.summary");
    const second = encryptField("Diagnosis: hypertension", "SoapNote.summary");
    // A deterministic ciphertext would let an observer match records by content.
    assert.notEqual(first, second);
    assert.equal(decryptField(first, "SoapNote.summary"), decryptField(second, "SoapNote.summary"));
  });
});

test("ciphertext moved to a different field will not decrypt", () => {
  withKeys(`k1:${KEY_A}`, "k1", () => {
    const stored = encryptField("Private note about the patient", "PrivateNote.content");
    // Simulates an attacker with write access relocating a value between fields.
    assert.throws(() => decryptField(stored, "Transcript.text"));
    assert.equal(decryptFieldOrNull(stored, "Transcript.text"), null);
  });
});

test("tampering with stored ciphertext is detected rather than silently accepted", () => {
  withKeys(`k1:${KEY_A}`, "k1", () => {
    const stored = encryptField("Assessment: stable", "SoapNote.content.assessment");
    const parts = stored.split(".");
    const body = Buffer.from(parts[4], "base64url");
    body[0] ^= 0xff;
    parts[4] = body.toString("base64url");

    assert.throws(() => decryptField(parts.join("."), "SoapNote.content.assessment"));
  });
});

test("records written under a retired key stay readable after rotation", () => {
  const legacy = withKeys(`k1:${KEY_A}`, "k1", () =>
    encryptField("Notes from the first visit", "PrivateNote.content")
  );

  withKeys(`k1:${KEY_A},k2:${KEY_B}`, "k2", () => {
    assert.equal(getActiveKeyId(), "k2");
    assert.deepEqual(listKeyIds(), ["k1", "k2"]);
    // Old rows decrypt under k1 while new writes use k2.
    assert.equal(decryptField(legacy, "PrivateNote.content"), "Notes from the first visit");
    assert.ok(encryptField("new", "PrivateNote.content").startsWith("enc.v1.k2."));
  });
});

test("rows written before the rollout are still readable", () => {
  withKeys(`k1:${KEY_A}`, "k1", () => {
    // Dual-read is what lets the backfill run against a live deployment.
    assert.equal(decryptField("legacy plaintext note", "PrivateNote.content"), "legacy plaintext note");
    assert.ok(!isEncrypted("legacy plaintext note"));
  });
});

test("SOAP sections are encrypted individually and keep the document shape", () => {
  withKeys(`k1:${KEY_A}`, "k1", () => {
    const content = { subjective: "<p>Headache</p>", objective: "<p>BP 130/85</p>" };
    const stored = encryptValues(content, "SoapNote.content");

    assert.deepEqual(Object.keys(stored), ["subjective", "objective"]);
    assert.ok(isEncrypted(stored.subjective));
    assert.ok(!JSON.stringify(stored).includes("Headache"));
    assert.deepEqual(decryptValues(stored, "SoapNote.content"), content);
  });
});

test("each SOAP section is bound to its own key so sections cannot be swapped", () => {
  withKeys(`k1:${KEY_A}`, "k1", () => {
    const stored = encryptValues({ subjective: "S", plan: "P" }, "SoapNote.content");
    const swapped = { subjective: stored.plan, plan: stored.subjective };
    const result = decryptValues(swapped, "SoapNote.content");
    assert.equal(result.subjective, "");
    assert.equal(result.plan, "");
  });
});

test("encryption is a no-op when no key is configured", () => {
  withKeys("", "", () => {
    assert.equal(isEncryptionConfigured(), false);
    // Lets the app boot before keys are provisioned rather than failing writes.
    assert.equal(encryptField("plain", "Transcript.text"), "plain");
  });
});

test("malformed key material is rejected at load rather than at first write", () => {
  assert.throws(
    () => withKeys("k1:tooshort", "k1", () => isEncryptionConfigured()),
    /must decode to 32 bytes/
  );
  assert.throws(
    () => withKeys(`k1:${KEY_A}`, "k9", () => isEncryptionConfigured()),
    /not present in PHI_ENCRYPTION_KEYS/
  );
});

test("empty and absent values pass through untouched", () => {
  withKeys(`k1:${KEY_A}`, "k1", () => {
    assert.equal(encryptField("", "Transcript.text"), "");
    assert.equal(encryptField(null, "Transcript.text"), null);
    assert.equal(encryptField(undefined, "Transcript.text"), undefined);
    assert.equal(decryptField(null, "Transcript.text"), null);
  });
});

test("encrypting an already encrypted value does not double-wrap it", () => {
  withKeys(`k1:${KEY_A}`, "k1", () => {
    const once = encryptField("Patient note", "PrivateNote.content");
    const twice = encryptField(once, "PrivateNote.content");
    assert.equal(once, twice);
    assert.equal(decryptField(twice, "PrivateNote.content"), "Patient note");
  });
});
