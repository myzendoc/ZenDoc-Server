import { listUsersWithMeetingCounts } from "../services/userService.js";

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
  return {
    id: user._id,
    name: displayName,
    email: user.email,
    totalMeetingHours: toHourString(user.totalMeetingSeconds || 0),
    totalMeetingSeconds: user.totalMeetingSeconds || 0,
    meetingCount: user.meetingCount || 0,
  };
}

export async function listUsers(req, res) {
  try {
    const users = await listUsersWithMeetingCounts();
    res.json({ users, dashboardUsers: users.map(toDashboardUser) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
}

export async function getAdminDashboard(req, res) {
  try {
    const users = await listUsersWithMeetingCounts();
    res.json({
      users: users.map(toDashboardUser),
      total: users.length,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
}
