import { getMeeting } from "./meetingService.js";
import { getUserById } from "./userService.js";

export const FREE_SOAP_TRANSCRIPT_LIMIT = 3;

export function isPaidSubscriber(user = null) {
  if (!user) return false;
  const status = String(user.subscriptionStatus || "").toLowerCase();
  const planKey = String(user.subscriptionPlanKey || "").toLowerCase();
  const active = status === "active" || status === "trialing";
  return active && planKey !== "free";
}

export async function getUserEntitlements(userId) {
  const id = String(userId || "").trim();
  if (!id) {
    return {
      userId: "",
      paid: false,
      free: true,
      screenShareAllowed: false,
      transcriptSoapSessionLimit: FREE_SOAP_TRANSCRIPT_LIMIT,
    };
  }

  const user = await getUserById(id);
  let paid = isPaidSubscriber(user);
  let viaGroup = false;
  if (!paid && user?.groupOwnerId) {
    const owner = await getUserById(user.groupOwnerId);
    if (isPaidSubscriber(owner)) {
      paid = true;
      viaGroup = true;
    }
  }
  return {
    userId: id,
    paid,
    free: !paid,
    viaGroup,
    planKey: String(user?.subscriptionPlanKey || "free"),
    status: String(user?.subscriptionStatus || "inactive"),
    screenShareAllowed: paid,
    transcriptSoapSessionLimit: paid ? Number.POSITIVE_INFINITY : FREE_SOAP_TRANSCRIPT_LIMIT,
  };
}

export async function getRoomEntitlements(roomId) {
  const meeting = await getMeeting(roomId);
  const ownerUserId = meeting?.createdBy ? String(meeting.createdBy) : "";
  if (!ownerUserId) {
    return {
      ownerUserId: "",
      paid: true,
      free: false,
      screenShareAllowed: true,
      transcriptSoapSessionLimit: Number.POSITIVE_INFINITY,
    };
  }
  const entitlements = await getUserEntitlements(ownerUserId);
  return { ownerUserId, ...entitlements };
}

export function isFreeSessionLimitExceeded(entitlements, sessionIndex) {
  if (!entitlements || entitlements.paid) return false;
  const idx = Number(sessionIndex || 0);
  if (!Number.isFinite(idx) || idx <= 0) return false;
  return idx > FREE_SOAP_TRANSCRIPT_LIMIT;
}

