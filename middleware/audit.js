import { createAuditLog } from "../services/auditLogService.js";
import {
  getCountryFromRequest,
  getIpFromRequest,
  getResourceTypeFromPath,
  parseBrowserFromUserAgent,
} from "../utils/audit.js";
import { logError } from "../utils/logging.js";

function getActorFromRequest(req) {
  const user = req.user || {};
  const actorUserId = user?._id ? String(user._id) : null;
  const actorRole = user?.role || "guest";
  const actorEmail = user?.email || req.body?.email || null;
  const actorName = user?.displayName || user?.firstName || null;
  return { actorUserId, actorRole, actorEmail, actorName };
}

export function getAuditResource(req, pathname = "") {
  const params = req.params || {};
  const parentResourceId = params.noteId && params.id ? String(params.id) : undefined;
  const resourceId = params.noteId || params.userId || params.roomId || params.id || null;
  let resourceType = getResourceTypeFromPath(pathname);
  if (pathname.includes("/notes/meetings")) resourceType = "meeting";
  else if (pathname.includes("/private-notes")) resourceType = "private_note";
  else if (pathname.includes("/notes")) resourceType = "soap_note";
  else if (pathname.includes("/dashboard/meetings")) resourceType = "meeting";
  else if (pathname.includes("/group/members")) resourceType = "user";
  else if (pathname.includes("/group/invites")) resourceType = "group_invite";
  else if (pathname.includes("/baa/")) resourceType = "baa";
  // Lifecycle and MFA events get their own resource types.
  else if (pathname.includes("/admin/users")) resourceType = "user";
  else if (pathname.includes("/auth/mfa")) resourceType = "mfa";
  return { resourceId, resourceType, parentResourceId };
}

export function shouldSkipAudit(pathname = "") {
  if (!pathname.startsWith("/api/")) return true;
  if (pathname === "/api/billing/webhook") return true;
  if (pathname.split("?")[0] === "/api/auth/session") return true;
  return false;
}

export function auditHttpActivity(req, res, next) {
  if (req.method === "OPTIONS" || shouldSkipAudit(req.originalUrl || req.url || "")) {
    next();
    return;
  }

  const started = Date.now();
  res.on("finish", () => {
    const rawPath = (req.originalUrl || req.url || "").split("?")[0];
    const pathname = req.route?.path
      ? `/api${req.route.path}`.replace(/\/+/g, "/")
      : rawPath.replace(/(\/group\/invites\/)[^/]+/i, "$1:token");
    const userAgent = String(req.headers?.["user-agent"] || "");
    const status = res.statusCode >= 400 ? "failure" : "success";
    const actor = getActorFromRequest(req);
    const resource = getAuditResource(req, pathname);
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
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
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
        parentResourceId: resource.parentResourceId,
      },
    }).catch((err) => {
      logError("audit.http_write_failed", err);
    });
  });

  next();
}
