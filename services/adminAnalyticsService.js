import { User } from "../models/user.js";
import { MeetingSession } from "../models/meetingSession.js";
import { SoapNote } from "../models/soapNote.js";
import { SessionParticipant } from "../models/sessionParticipant.js";
import { AuthSession } from "../models/authSession.js";
import { AuditLog } from "../models/auditLog.js";
import { getPlanCatalog } from "./billingService.js";

const ACTIVE_SUBSCRIPTION = ["active", "trialing"];

function windowStarts(now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  const month = new Date(today);
  month.setDate(month.getDate() - 29);
  return { today, week, month };
}

// Normalises every plan to a monthly figure so weekly and yearly plans compare.
function monthlyCents(planKey, catalog) {
  const plan = catalog.find((p) => p.key === planKey);
  if (!plan || !plan.amount) return 0;
  if (plan.interval === "week") return Math.round((plan.amount * 52) / 12);
  if (plan.interval === "year") return Math.round(plan.amount / 12);
  return plan.amount;
}

async function distinctActiveProviders(since) {
  const ids = await AuditLog.distinct("actorUserId", {
    actorUserId: { $ne: null },
    actorRole: "provider",
    createdAt: { $gte: since },
  });
  return ids.length;
}

export async function getAdminAnalytics() {
  const catalog = getPlanCatalog();
  const { today, week, month } = windowStarts();

  const [
    totalProviders,
    activeProviders,
    totalAdmins,
    totalConsultations,
    totalSoapNotes,
    platformVisits,
    visitsThisMonth,
    subscribers,
    durations,
    patientAttendances,
    countries,
    activeToday,
    activeWeek,
    activeMonth,
  ] = await Promise.all([
    User.countDocuments({ role: "provider" }),
    User.countDocuments({ role: "provider", status: { $ne: "deactivated" } }),
    User.countDocuments({ role: "admin" }),
    MeetingSession.countDocuments({}),
    SoapNote.countDocuments({}),
    AuthSession.countDocuments({}),
    AuthSession.countDocuments({ createdAt: { $gte: month } }),
    User.find({ subscriptionStatus: { $in: ACTIVE_SUBSCRIPTION } })
      .select("subscriptionPlanKey")
      .lean(),
    MeetingSession.aggregate([
      { $match: { startedAt: { $ne: null }, endedAt: { $ne: null } } },
      { $group: { _id: null, ms: { $sum: { $subtract: ["$endedAt", "$startedAt"] } } } },
    ]),
    SessionParticipant.countDocuments({ role: "guest" }),
    AuditLog.distinct("country", { country: { $nin: [null, ""] } }),
    distinctActiveProviders(today),
    distinctActiveProviders(week),
    distinctActiveProviders(month),
  ]);

  const monthlyRevenueCents = subscribers.reduce(
    (sum, user) => sum + monthlyCents(user.subscriptionPlanKey, catalog),
    0
  );
  const totalMinutes = Math.round((durations[0]?.ms || 0) / 60000);

  return {
    providers: { total: totalProviders, active: activeProviders, admins: totalAdmins },
    // peerIds are per-visit, so this is attendances rather than distinct humans.
    patients: { attendances: patientAttendances },
    consultations: {
      total: totalConsultations,
      totalMinutes,
      averageMinutes: totalConsultations ? Math.round(totalMinutes / totalConsultations) : 0,
    },
    soapNotes: { total: totalSoapNotes },
    revenue: {
      currency: "usd",
      monthlyCents: monthlyRevenueCents,
      annualisedCents: monthlyRevenueCents * 12,
      payingSubscribers: subscribers.length,
    },
    activeProviders: { today: activeToday, week: activeWeek, month: activeMonth },
    countries: { count: countries.length, list: countries.sort() },
    platformVisits: { total: platformVisits, last30Days: visitsThisMonth },
  };
}
