import { listMeetingSessionsWithContext } from "../services/meetingSessionService.js";
import { getParticipantsByRooms } from "../services/transcriptService.js";

function monthKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

function monthLabel(key) {
  if (!key) return "";
  const [y, m] = key.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, 1);
  return dt.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export async function getAnalyticsSummary(req, res) {
  try {
    const includeAll = req.user?.role === "admin";
    const sessions = await listMeetingSessionsWithContext(req.user?._id, includeAll);
    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;

    let totalSessions = 0;
    let totalMinutes = 0;
    let thisMonthSessions = 0;
    const monthCounts = new Map();
    const monthMinutes = new Map();

    sessions.forEach((m) => {
      totalSessions += 1;
      const start = m.startedAt || m.createdAt;
      const end = m.endedAt || m.startedAt || m.createdAt;
      const durationMs = start && end ? Math.max(new Date(end) - new Date(start), 0) : 0;
      const durationMin = durationMs / 60000;
      totalMinutes += durationMin;
      const key = monthKey(start || end);
      if (key) {
        monthCounts.set(key, (monthCounts.get(key) || 0) + 1);
        monthMinutes.set(key, (monthMinutes.get(key) || 0) + durationMin);
        if (key === currentMonthKey) thisMonthSessions += 1;
      }
    });

    const averageSessionTime = totalSessions ? Math.round(totalMinutes / totalSessions) : 0;
    const averagePerMonth =
      monthCounts.size ? Math.round(Array.from(monthCounts.values()).reduce((a, b) => a + b, 0) / monthCounts.size) : 0;

    let mostSessionsMonthKey = "";
    let mostSessionsValue = 0;
    monthCounts.forEach((value, key) => {
      if (value > mostSessionsValue) {
        mostSessionsValue = value;
        mostSessionsMonthKey = key;
      }
    });

    let mostMinutesMonthKey = "";
    let mostMinutesValue = 0;
    monthMinutes.forEach((value, key) => {
      if (value > mostMinutesValue) {
        mostMinutesValue = value;
        mostMinutesMonthKey = key;
      }
    });

    const roomIds = sessions.map((m) => m.roomId).filter(Boolean);
    const participants = await getParticipantsByRooms(roomIds);

    res.json({
      totals: {
        sessions: totalSessions,
        minutes: Math.round(totalMinutes),
        averageSessionTime: Math.round(averageSessionTime),
        participants,
      },
      highlights: {
        averagePerMonth,
        thisMonthSessions,
        mostSessions: { label: monthLabel(mostSessionsMonthKey), value: mostSessionsValue },
        mostMinutes: { label: monthLabel(mostMinutesMonthKey), value: Math.round(mostMinutesValue) },
        totalSessions,
        totalMinutes: Math.round(totalMinutes),
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
}
