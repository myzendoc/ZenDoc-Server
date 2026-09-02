#!/usr/bin/env node
/**
 * Backfills and rotates encryption on the PHI-bearing fields.
 *
 *   node scripts/encryptPhi.js keygen              # print a fresh 256-bit key
 *   node scripts/encryptPhi.js status              # how much is encrypted so far
 *   node scripts/encryptPhi.js migrate --dry-run   # report without writing
 *   node scripts/encryptPhi.js migrate             # encrypt anything still plaintext
 *   node scripts/encryptPhi.js rotate              # re-encrypt under the active key
 *
 * The services read plaintext and ciphertext interchangeably, so `migrate` can
 * run against a live deployment: rows flip over one batch at a time and both
 * states stay readable throughout.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { connectDatabase } from "../db.js";
import { Transcript } from "../models/transcript.js";
import { SoapNote } from "../models/soapNote.js";
import { PrivateNote } from "../models/privateNote.js";
import { Meeting } from "../models/meeting.js";
import { MeetingSession } from "../models/meetingSession.js";
import {
  decryptField,
  encryptField,
  generateKeyMaterial,
  getActiveKeyId,
  isEncrypted,
  isEncryptionConfigured,
} from "../utils/fieldCipher.js";

dotenv.config();

const BATCH_SIZE = 200;

// Mirrors the field contexts used by the services. Keep in sync: a mismatch
// makes the AAD wrong and every affected record undecryptable.
const TARGETS = [
  { name: "Transcript.text", model: Transcript, field: "text", context: "Transcript.text" },
  { name: "PrivateNote.content", model: PrivateNote, field: "content", context: "PrivateNote.content" },
  { name: "SoapNote.summary", model: SoapNote, field: "summary", context: "SoapNote.summary" },
  { name: "Meeting.title", model: Meeting, field: "title", context: "Meeting.title" },
  { name: "Meeting.description", model: Meeting, field: "description", context: "Meeting.description" },
  { name: "MeetingSession.title", model: MeetingSession, field: "title", context: "MeetingSession.title" },
  {
    name: "SoapNote.content",
    model: SoapNote,
    field: "content",
    context: "SoapNote.content",
    // Sections are encrypted individually, each bound to SoapNote.content.<key>.
    nested: true,
  },
];

function parseArgs(argv) {
  const args = { _: [] };
  for (const token of argv) {
    if (token.startsWith("--")) args[token.slice(2)] = true;
    else args._.push(token);
  }
  return args;
}

function transformValue(value, context, { rotate }) {
  if (typeof value !== "string" || !value) return null;
  if (isEncrypted(value)) {
    if (!rotate) return null;
    const parts = value.split(".");
    if (parts[2] === getActiveKeyId()) return null;
    return encryptField(decryptField(value, context), context);
  }
  return encryptField(value, context);
}

function transformNested(content, context, options) {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  let changed = false;
  const next = { ...content };
  for (const [key, value] of Object.entries(content)) {
    const updated = transformValue(value, `${context}.${key}`, options);
    if (updated !== null) {
      next[key] = updated;
      changed = true;
    }
  }
  return changed ? next : null;
}

async function processTarget(target, options) {
  const { model, field, context, nested } = target;
  const filter = { [field]: { $exists: true, $ne: null } };
  const cursor = model.find(filter).select(`_id ${field}`).lean().cursor();

  let scanned = 0;
  let changed = 0;
  let operations = [];

  const flush = async () => {
    if (!operations.length) return;
    if (!options.dryRun) await model.bulkWrite(operations, { ordered: false });
    operations = [];
  };

  for await (const doc of cursor) {
    scanned += 1;
    const next = nested
      ? transformNested(doc[field], context, options)
      : transformValue(doc[field], context, options);
    if (next === null) continue;
    changed += 1;
    operations.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { [field]: next } } } });
    if (operations.length >= BATCH_SIZE) await flush();
  }
  await flush();

  return { scanned, changed };
}

async function run(options) {
  if (!isEncryptionConfigured()) {
    throw new Error("PHI_ENCRYPTION_KEYS is not set; nothing to encrypt with");
  }
  console.log(`Active key: ${getActiveKeyId()}${options.dryRun ? "  (dry run)" : ""}`);
  let totalChanged = 0;
  for (const target of TARGETS) {
    const { scanned, changed } = await processTarget(target, options);
    totalChanged += changed;
    console.log(`${target.name.padEnd(24)} scanned ${String(scanned).padStart(7)}  ${options.rotate ? "rotated" : "encrypted"} ${changed}`);
  }
  console.log(
    options.dryRun
      ? `\n${totalChanged} record(s) would change. Re-run without --dry-run to apply.`
      : `\n${totalChanged} record(s) updated.`
  );
}

async function status() {
  for (const target of TARGETS) {
    const cursor = target.model.find({ [target.field]: { $exists: true, $ne: null } })
      .select(`_id ${target.field}`)
      .lean()
      .cursor();
    let total = 0;
    let encryptedCount = 0;
    for await (const doc of cursor) {
      const value = doc[target.field];
      const values = target.nested && value && typeof value === "object" ? Object.values(value) : [value];
      const strings = values.filter((item) => typeof item === "string" && item);
      if (!strings.length) continue;
      total += 1;
      if (strings.every(isEncrypted)) encryptedCount += 1;
    }
    const pct = total ? Math.round((encryptedCount / total) * 100) : 100;
    console.log(`${target.name.padEnd(24)} ${String(encryptedCount).padStart(7)}/${String(total).padEnd(7)} encrypted (${pct}%)`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "status";

  if (command === "keygen") {
    const key = generateKeyMaterial();
    const keyId = `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    console.log(`PHI_ENCRYPTION_KEYS=${keyId}:${key}`);
    console.log(`PHI_ENCRYPTION_ACTIVE_KEY=${keyId}`);
    console.log("\nWhen rotating, append the new pair to the existing list and keep the old key present");
    console.log("so historical records stay readable until `rotate` finishes.");
    return;
  }

  await connectDatabase();
  try {
    if (command === "status") await status();
    else if (command === "migrate") await run({ dryRun: Boolean(args["dry-run"]), rotate: false });
    else if (command === "rotate") await run({ dryRun: Boolean(args["dry-run"]), rotate: true });
    else {
      console.error("Usage: node scripts/encryptPhi.js <keygen|status|migrate|rotate> [--dry-run]");
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
