import { AuditLog } from "../models/auditLog.js";
import crypto from "crypto";
import mongoose from "mongoose";
import { parseBrowserFromUserAgent } from "../utils/audit.js";
import { claimChainSlot, isChainConfigured, verifyEntry } from "../utils/auditChain.js";

function toSafeString(value = "") {
  const text = String(value || "").trim();
  return text || undefined;
}

function normalizeActorId(actorUserId) {
  const id = String(actorUserId || "").trim();
  if (!id || id === "env-admin") return null;
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return id;
}

const AUDIT_RETRY_DELAYS_MS = [100, 500, 1500];
const ALLOWED_METADATA_KEYS = new Set([
  "statusCode",
  "durationMs",
  "bodyKeys",
  "reason",
  "peerId",
  "queued",
  "targetPeerId",
  "soapsGenerated",
  "documentVersion",
  "parentResourceId",
  "role",
]);

function sanitizeMetadataValue(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return undefined;
  if (["boolean", "number"].includes(typeof value)) return value;
  if (typeof value === "string") return value.slice(0, 256);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeMetadataValue(item, depth + 1));
  }
  return undefined;
}

export function sanitizeAuditMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => ALLOWED_METADATA_KEYS.has(key))
      .map(([key, value]) => [key, sanitizeMetadataValue(value)])
      .filter(([, value]) => value !== undefined)
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withAuditRetry(operation, delays = AUDIT_RETRY_DELAYS_MS) {
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === delays.length) break;
      await wait(delays[attempt]);
    }
  }
  throw lastError;
}

export async function createAuditLog(payload = {}) {
  const userAgent = toSafeString(payload.userAgent) || "";
  const actorRole = ["admin", "provider"].includes(payload.actorRole) ? payload.actorRole : "guest";
  const actorSubject = toSafeString(payload.actorUserId);
  const eventId = toSafeString(payload.eventId) || crypto.randomUUID();
  const record = {
    eventId,
    actorUserId: normalizeActorId(payload.actorUserId),
    actorSubject,
    actorRole,
    actorEmail: toSafeString(payload.actorEmail),
    actorName: toSafeString(payload.actorName),
    action: toSafeString(payload.action) || "unknown",
    resourceType: toSafeString(payload.resourceType) || "api",
    resourceId: payload.resourceId ? String(payload.resourceId) : undefined,
    status: payload.status === "failure" ? "failure" : "success",
    ipAddress: toSafeString(payload.ipAddress),
    country: toSafeString(payload.country),
    userAgent: userAgent || undefined,
    browser: toSafeString(payload.browser) || parseBrowserFromUserAgent(userAgent),
    method: toSafeString(payload.method),
    path: toSafeString(payload.path),
    metadata: sanitizeAuditMetadata(payload.metadata),
  };
  return withAuditRetry(async () => {
    try {
      // Claim the slot first; a crash leaves a gap that verification reports.
      const chain = isChainConfigured() ? await claimChainSlot(record) : null;
      return await AuditLog.create(chain ? { ...record, ...chain } : record);
    } catch (err) {
      if (err?.code === 11000) return AuditLog.findOne({ eventId });
      throw err;
    }
  });
}

// Walks the chain in order and reports the first break of each kind.
export async function verifyAuditChain({ from, to } = {}) {
  const filter = { sequence: { $ne: null } };
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }

  const cursor = AuditLog.find(filter).sort({ sequence: 1 }).lean().cursor();
  const problems = [];
  let checked = 0;
  let expectedSequence = null;
  let previousHash = "";

  for await (const entry of cursor) {
    if (expectedSequence === null) {
      expectedSequence = entry.sequence;
      previousHash = entry.previousHash || "";
    }
    if (entry.sequence !== expectedSequence) {
      problems.push({
        type: "gap",
        expectedSequence,
        foundSequence: entry.sequence,
        eventId: entry.eventId,
      });
      expectedSequence = entry.sequence;
    }
    if ((entry.previousHash || "") !== previousHash) {
      problems.push({ type: "broken_link", sequence: entry.sequence, eventId: entry.eventId });
    }
    if (!verifyEntry(entry, entry.previousHash || "")) {
      problems.push({ type: "tampered", sequence: entry.sequence, eventId: entry.eventId });
    }
    previousHash = entry.entryHash;
    expectedSequence += 1;
    checked += 1;
  }

  const unchained = await AuditLog.countDocuments({ sequence: null });
  return { ok: problems.length === 0, checked, unchained, problems };
}

export async function listAuditLogs({
  page = 1,
  limit = 20,
  search = "",
  action = "",
  from = "",
  to = "",
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (safePage - 1) * safeLimit;

  const filter = {};
  const safeAction = String(action || "").trim();
  if (safeAction) filter.action = safeAction;

  const range = {};
  if (from) {
    const fromDate = new Date(from);
    if (!Number.isNaN(fromDate.getTime())) range.$gte = fromDate;
  }
  if (to) {
    const toDate = new Date(to);
    if (!Number.isNaN(toDate.getTime())) range.$lte = toDate;
  }
  if (Object.keys(range).length) filter.createdAt = range;

  const safeSearch = String(search || "").trim();
  if (safeSearch) {
    const regex = new RegExp(safeSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { actorEmail: regex },
      { actorName: regex },
      { ipAddress: regex },
      { country: regex },
      { browser: regex },
      { action: regex },
      { path: regex },
      { resourceType: regex },
      { resourceId: regex },
      { status: regex },
      { actorSubject: regex },
    ];
  }

  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    AuditLog.countDocuments(filter),
  ]);

  return {
    logs: logs.map((log) => ({ ...log, timestamp: log.createdAt })),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}
