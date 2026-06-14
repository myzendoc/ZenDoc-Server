import { createAuditLog } from "../services/auditLogService.js";
import {
  getCountryFromRequest,
  getIpFromRequest,
  getResourceTypeFromPath,
  parseBrowserFromUserAgent,
} from "../utils/audit.js";

function getActorFromRequest(req) {
  const user = req.user || {};
  const actorUserId = user?._id ? String(user._id) : null;
  const actorRole = user?.role || "guest";
  const actorEmail = user?.email || req.body?.email || null;
  const actorName = user?.displayName || user?.firstName || null;
  return { actorUserId, actorRole, actorEmail, actorName };
}

function getResourceId(req) {
  return req.params?.id || req.params?.noteId || req.params?.roomId || null;
}

function shouldSkip(pathname = "") {
  if (!pathname.startsWith("/api/")) return true;
  if (pathname === "/api/billing/webhook") return true;
  return false;
}

export function auditHttpActivity(req, res, next) {
  if (req.method === "OPTIONS" || shouldSkip(req.originalUrl || req.url || "")) {
    next();
    return;
  }

  const started = Date.now();
  const pathname = (req.originalUrl || req.url || "").split("?")[0];

  res.on("finish", () => {
    const userAgent = String(req.headers?.["user-agent"] || "");
    const status = res.statusCode >= 400 ? "failure" : "success";
    const actor = getActorFromRequest(req);
    const bodyKeys =
      req.body &&
      typeof req.body === "object" &&
      !Buffer.isBuffer(req.body) &&
      !Array.isArray(req.body)
        ? Object.keys(req.body).slice(0, 20)
        : [];
    createAuditLog({
      ...actor,
      action: `${req.method} ${pathname.replace(/^\/api/, "") || "/"}`,
      resourceType: getResourceTypeFromPath(pathname),
      resourceId: getResourceId(req),
      status,
      ipAddress: getIpFromRequest(req),
      country: getCountryFromRequest(req),
      userAgent,
      browser: parseBrowserFromUserAgent(userAgent),
      method: req.method,
      path: pathname,
      metadata: {
        statusCode: res.statusCode,
        durationMs: Date.now() - started,
        bodyKeys,
      },
    }).catch((err) => {
      console.error("audit http log failed", err?.message || err);
    });
  });

  next();
}
