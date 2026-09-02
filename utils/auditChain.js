import crypto from "crypto";
import { AuditChainHead } from "../models/auditChainHead.js";

const HEAD_ID = "audit";
const CAS_ATTEMPTS = 5;

// Fields covered by the hash.
const SIGNED_FIELDS = [
  "eventId",
  "actorUserId",
  "actorSubject",
  "actorRole",
  "actorEmail",
  "action",
  "resourceType",
  "resourceId",
  "status",
  "ipAddress",
  "method",
  "path",
];

function chainSecret() {
  return process.env.AUDIT_CHAIN_SECRET || process.env.JWT_SECRET || "";
}

export function isChainConfigured() {
  return Boolean(chainSecret());
}

// Stable serialization: key order must not depend on object construction order.
function canonicalize(record) {
  return JSON.stringify(
    SIGNED_FIELDS.map((field) => {
      const value = record?.[field];
      return value === undefined || value === null ? "" : String(value);
    })
  );
}

export function computeEntryHash({ record, sequence, previousHash }) {
  return crypto
    .createHmac("sha256", chainSecret())
    .update(`${sequence}\n${previousHash}\n${canonicalize(record)}`)
    .digest("hex");
}

// Claims the next slot atomically, returning the values to stamp on the record.
export async function claimChainSlot(record) {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const head =
      (await AuditChainHead.findById(HEAD_ID).lean()) ||
      (await AuditChainHead.findOneAndUpdate(
        { _id: HEAD_ID },
        { $setOnInsert: { sequence: 0, lastHash: "" } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean());

    const sequence = (head.sequence || 0) + 1;
    const previousHash = head.lastHash || "";
    const entryHash = computeEntryHash({ record, sequence, previousHash });

    const claimed = await AuditChainHead.findOneAndUpdate(
      { _id: HEAD_ID, sequence: head.sequence || 0 },
      { $set: { sequence, lastHash: entryHash } },
      { new: true }
    ).lean();

    if (claimed) return { sequence, previousHash, entryHash };
  }
  throw new Error("Could not claim an audit chain slot after repeated contention");
}

export function verifyEntry(entry, previousHash) {
  const expected = computeEntryHash({
    record: entry,
    sequence: entry.sequence,
    previousHash,
  });
  return expected === entry.entryHash;
}

export { SIGNED_FIELDS };
