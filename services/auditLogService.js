import { AuditLog } from "../models/auditLog.js";
import mongoose from "mongoose";
import { parseBrowserFromUserAgent } from "../utils/audit.js";

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

function sanitizeMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object") return {};
  const clone = { ...metadata };
  delete clone.password;
  delete clone.token;
  delete clone.otpCode;
  delete clone.resetPasswordToken;
  return clone;
}

export async function createAuditLog(payload = {}) {
  const userAgent = toSafeString(payload.userAgent) || "";
  const actorRole = ["admin", "provider"].includes(payload.actorRole) ? payload.actorRole : "guest";
  return AuditLog.create({
    actorUserId: normalizeActorId(payload.actorUserId),
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
    metadata: sanitizeMetadata(payload.metadata),
  });
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
