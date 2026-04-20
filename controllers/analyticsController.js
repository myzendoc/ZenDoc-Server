import { listMeetingSessionsWithContext } from "../services/meetingSessionService.js";
import { getParticipantCountsByRoomSession } from "../services/transcriptService.js";

function monthKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    let totalSessions = 0;
    let totalMinutes = 0;
    let thisMonthSessions = 0;
    const monthCounts = new Map();
    const monthMinutes = new Map();
    const monthParticipants = new Map();

    const roomIds = [...new Set(sessions.map((m) => m.roomId).filter(Boolean))];
    const participantCountsBySession = await getParticipantCountsByRoomSession(roomIds);

    sessions.forEach((m) => {
      totalSessions += 1;
      const start = m.startedAt || m.createdAt;
      const end = m.endedAt || m.startedAt || m.createdAt;
      const durationMs = start && end ? Math.max(new Date(end) - new Date(start), 0) : 0;
      const durationMin = durationMs / 60000;
      const sessionParticipants = participantCountsBySession[`${m.roomId}:${m.sessionIndex ?? 0}`] || 0;
      totalMinutes += durationMin;
      const key = monthKey(start || end);
      if (key) {
        monthCounts.set(key, (monthCounts.get(key) || 0) + 1);
        monthMinutes.set(key, (monthMinutes.get(key) || 0) + durationMin);
        monthParticipants.set(key, (monthParticipants.get(key) || 0) + sessionParticipants);
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

    const participants = Object.values(participantCountsBySession).reduce((sum, value) => sum + value, 0);

    if (!monthCounts.has(currentMonthKey)) {
      monthCounts.set(currentMonthKey, 0);
      monthMinutes.set(currentMonthKey, 0);
      monthParticipants.set(currentMonthKey, 0);
    }

    const months = Array.from(monthCounts.keys())
      .sort((a, b) => b.localeCompare(a))
      .map((key) => {
        const sessionsInMonth = monthCounts.get(key) || 0;
        const minutesInMonth = monthMinutes.get(key) || 0;
        const participantsInMonth = monthParticipants.get(key) || 0;

        return {
          key,
          label: monthLabel(key),
          sessions: sessionsInMonth,
          minutes: Math.round(minutesInMonth),
          averageSessionTime: sessionsInMonth ? Math.round(minutesInMonth / sessionsInMonth) : 0,
          participants: participantsInMonth,
        };
      });

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
      currentMonthKey,
      months,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
}
