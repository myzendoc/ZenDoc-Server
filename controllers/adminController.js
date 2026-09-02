import {
  deactivateUser,
  listUsersWithMeetingCounts,
  reactivateUser,
  setUserRole,
} from "../services/userService.js";
import { listAuditLogs } from "../services/auditLogService.js";
import { getScheduledJobStatus } from "../services/scheduler.js";
import { getRetentionSummary } from "../services/retentionService.js";
import { sendErrorResponse } from "../utils/errors.js";

function toHourString(totalSeconds = 0) {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds].map((v) => String(v).padStart(2, "0")).join(":");
}

function toDashboardUser(user) {
  const first = String(user.firstName || "").trim();
  const last = String(user.lastName || "").trim();
  const display = String(user.displayName || "").trim();
  const email = String(user.email || "").trim().toLowerCase();
  const emailLocal = email.includes("@") ? email.split("@")[0] : email;
  const firstIsEmailLocal = first && emailLocal && first.toLowerCase() === emailLocal;
  const preferredFromNames = display || last || (firstIsEmailLocal ? "" : first);
  const displayName = preferredFromNames || emailLocal || "User";
  const sessions = user.meetingCount || 0;
  const totalSeconds = user.totalMeetingSeconds || 0;
  const avgSeconds = sessions > 0 ? Math.floor(totalSeconds / sessions) : 0;
  return {
    id: user._id,
    name: displayName,
    email: user.email,
    totalMeetingHours: toHourString(totalSeconds),
    totalMeetingSeconds: totalSeconds,
    meetingCount: sessions,
    avgSessionTime: toHourString(avgSeconds),
    avgSessionSeconds: avgSeconds,
    lastActiveAt: user.lastMeetingAt || null,
    role: user.role,
    status: user.status || "active",
    isActive: user.isActive !== false,
    mfaEnabled: Boolean(user.mfaEnabled),
    deactivatedAt: user.deactivatedAt || null,
    deactivationReason: user.deactivationReason || "",
  };
}

export async function listUsers(req, res) {
  try {
    const users = await listUsersWithMeetingCounts();
    res.json({
      users,
      dashboardUsers: users.map(toDashboardUser),
      totalUsers: users.length,
      total: users.length,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
}

export async function getAdminDashboard(req, res) {
  try {
    const users = await listUsersWithMeetingCounts();
    res.json({
      users: users.map(toDashboardUser),
      totalUsers: users.length,
      total: users.length,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
}

export async function getAdminAuditLogs(req, res) {
  try {
    const { page, limit, search, action, from, to } = req.query || {};
    const result = await listAuditLogs({ page, limit, search, action, from, to });
    res.json(result);
  } catch {
    res.status(500).json({ error: "Failed to fetch audit logs" });
  }
}

export async function getComplianceStatus(req, res) {
  try {
    const [jobs, retention] = await Promise.all([getScheduledJobStatus(), getRetentionSummary()]);
    res.json({ jobs, retention });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to load compliance status", status: 500, event: "admin.compliance_status_failed" });
  }
}

export async function deactivateUserAccount(req, res) {
  try {
    const user = await deactivateUser(req.params.userId, {
      actorId: req.user?._id,
      reason: req.body?.reason,
    });
    res.json({ user, message: `${user.email} has been deactivated` });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to deactivate user", status: 400, event: "admin.user_deactivate_failed" });
  }
}

export async function reactivateUserAccount(req, res) {
  try {
    const user = await reactivateUser(req.params.userId, { actorId: req.user?._id });
    res.json({ user, message: `${user.email} has been reactivated` });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to reactivate user", status: 400, event: "admin.user_reactivate_failed" });
  }
}

export async function updateUserRole(req, res) {
  try {
    const user = await setUserRole(req.params.userId, req.body?.role, { actorId: req.user?._id });
    res.json({ user, message: `${user.email} is now ${user.role === "admin" ? "an administrator" : "a provider"}` });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to update role", status: 400, event: "admin.user_role_failed" });
  }
}
