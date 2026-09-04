import express from "express";
import passport, { isGoogleAuthEnabled } from "../config/passport.js";
import { signup, login, logout, me, refreshSession, touchSession, updateProfile, sendOtp, verifyOtp, forgotPassword, resetPassword, googleCallback, googleFailure, changePassword, changeEmail, verifyEmailChange, disconnectGoogle, verifyMfa, getMfa, startMfaEnrollment, confirmMfa, turnOffMfa, refreshRecoveryCodes, getTrustedDevices, deleteTrustedDevice, deleteAllTrustedDevices } from "../controllers/authController.js";
import { downloadBaaDocument } from "../controllers/baaController.js";
import { getGroup, postInvite, lookupInvite, postAcceptInvite, deleteMember, deleteInvite, postLeave, postDeactivateMember, postReactivateMember } from "../controllers/groupController.js";
import {
  createDashboardMeeting,
  createPrivateMeetingNote,
  deleteNotesMeeting,
  getDashboardMeeting,
  getMeetingNotes,
  getPrivateMeetingNotes,
  getPublicMeeting,
  listDashboardMeetings,
  createMeetingNote,
  updateMeetingNote,
  listNotesMeetings,
  getNotesMeeting,
  invitePatientToMeeting,
  renameNotesMeeting,
} from "../controllers/dashboardController.js";
import {
  deactivateUserAccount,
  getAdminAuditLogs,
  getAdminDashboard,
  getComplianceStatus,
  listUsers,
  reactivateUserAccount,
  updateUserRole,
} from "../controllers/adminController.js";
import { attachMfaChallenge, requireAdmin, requireAuth } from "../middleware/auth.js";
import {
  closeBreakGlass,
  getBreakGlassRecords,
  listBreakGlass,
  openBreakGlass,
} from "../controllers/breakGlassController.js";
import { getAnalyticsSummary } from "../controllers/analyticsController.js";
import {
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
  listBillingPlans,
} from "../controllers/billingController.js";
import {
  accountVerificationRateLimit,
  invitationRateLimit,
  loginRateLimit,
  otpSendRateLimit,
  otpVerifyRateLimit,
  passwordResetRateLimit,
  passwordResetRequestRateLimit,
  signupRateLimit,
  mfaVerifyRateLimit,
} from "../middleware/rateLimit.js";

const router = express.Router();

router.use("/auth", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.post("/auth/signup", signupRateLimit, signup);
router.post("/auth/login", loginRateLimit, login);
router.post("/auth/refresh", refreshSession);
router.post("/auth/logout", logout);
router.post("/auth/session", requireAuth, touchSession);
router.get("/auth/google", (req, res, next) => {
  if (!isGoogleAuthEnabled()) {
    res.status(503).json({ error: "Google auth is not configured" });
    return;
  }
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
    prompt: "select_account",
  })(req, res, next);
});
router.get("/auth/google/callback", (req, res, next) => {
  if (!isGoogleAuthEnabled()) {
    res.status(503).json({ error: "Google auth is not configured" });
    return;
  }
  passport.authenticate("google", { session: false, failureRedirect: "/api/auth/google/failure" })(req, res, next);
}, googleCallback);
router.get("/auth/google/failure", googleFailure);
router.get("/auth/me", requireAuth, me);
router.post("/auth/profile", requireAuth, updateProfile);
router.post("/auth/send-otp", otpSendRateLimit, sendOtp);
router.post("/auth/verify-otp", otpVerifyRateLimit, verifyOtp);
router.post("/auth/forgot-password", passwordResetRequestRateLimit, forgotPassword);
router.post("/auth/reset-password", passwordResetRateLimit, resetPassword);
router.post("/auth/change-password", requireAuth, changePassword);
router.post("/auth/change-email", requireAuth, otpSendRateLimit, changeEmail);
router.post("/auth/verify-email-change", requireAuth, accountVerificationRateLimit, verifyEmailChange);
router.post("/auth/google/disconnect", requireAuth, disconnectGoogle);
// Completes a half-authenticated login; guarded by the challenge cookie, not requireAuth.
router.post("/auth/mfa/verify", attachMfaChallenge, mfaVerifyRateLimit, verifyMfa);
router.get("/auth/mfa", requireAuth, getMfa);
router.post("/auth/mfa/enroll", requireAuth, startMfaEnrollment);
router.post("/auth/mfa/confirm", requireAuth, mfaVerifyRateLimit, confirmMfa);
router.post("/auth/mfa/disable", requireAuth, mfaVerifyRateLimit, turnOffMfa);
router.post("/auth/mfa/recovery-codes", requireAuth, mfaVerifyRateLimit, refreshRecoveryCodes);
router.get("/auth/devices", requireAuth, getTrustedDevices);
router.delete("/auth/devices/:deviceId", requireAuth, deleteTrustedDevice);
router.delete("/auth/devices", requireAuth, deleteAllTrustedDevices);
router.get("/baa/document", requireAuth, downloadBaaDocument);
router.get("/group", requireAuth, getGroup);
router.post("/group/invites", requireAuth, invitationRateLimit, postInvite);
router.get("/group/invites/:token", lookupInvite);
router.post("/group/invites/accept", requireAuth, postAcceptInvite);
router.delete("/group/invites/:id", requireAuth, deleteInvite);
router.delete("/group/members/:userId", requireAuth, deleteMember);
router.post("/group/members/:userId/deactivate", requireAuth, postDeactivateMember);
router.post("/group/members/:userId/reactivate", requireAuth, postReactivateMember);
router.post("/group/leave", requireAuth, postLeave);
router.get("/billing/plans", listBillingPlans);
router.post("/billing/checkout-session", requireAuth, createCheckoutSession);
router.get("/billing/status", requireAuth, getBillingStatus);
router.post("/billing/portal-session", requireAuth, createPortalSession);

router.post("/dashboard/meetings", requireAuth, createDashboardMeeting);
router.get("/dashboard/meetings", requireAuth, listDashboardMeetings);
router.post("/dashboard/meetings/:roomId/invitations", requireAuth, invitationRateLimit, invitePatientToMeeting);
router.get("/dashboard/meetings/:id", requireAuth, getDashboardMeeting);
router.post("/dashboard/meetings/:id/notes", requireAuth, createMeetingNote);
router.get("/dashboard/meetings/:id/notes", requireAuth, getMeetingNotes);
router.patch("/dashboard/meetings/:id/notes/:noteId", requireAuth, updateMeetingNote);
router.post("/dashboard/meetings/:id/private-notes", requireAuth, createPrivateMeetingNote);
router.get("/dashboard/meetings/:id/private-notes", requireAuth, getPrivateMeetingNotes);
router.get("/notes/meetings", requireAuth, listNotesMeetings);
router.get("/notes/meetings/:id", requireAuth, getNotesMeeting);
router.patch("/notes/meetings/:id", requireAuth, renameNotesMeeting);
router.delete("/notes/meetings/:id", requireAuth, deleteNotesMeeting);

router.get("/public/meetings/:roomId", getPublicMeeting);

router.get("/admin/users", requireAuth, requireAdmin, listUsers);
router.post("/admin/users/:userId/deactivate", requireAuth, requireAdmin, deactivateUserAccount);
router.post("/admin/users/:userId/reactivate", requireAuth, requireAdmin, reactivateUserAccount);
router.post("/admin/users/:userId/role", requireAuth, requireAdmin, updateUserRole);
router.get("/admin/dashboard", requireAuth, requireAdmin, getAdminDashboard);
router.get("/admin/audit-logs", requireAuth, requireAdmin, getAdminAuditLogs);
router.get("/admin/compliance", requireAuth, requireAdmin, getComplianceStatus);
// Emergency access (§164.312(a)(2)(ii)) — every route here is audited by default.
router.post("/admin/break-glass", requireAuth, requireAdmin, mfaVerifyRateLimit, openBreakGlass);
router.get("/admin/break-glass", requireAuth, requireAdmin, listBreakGlass);
router.get("/admin/break-glass/:grantId/records", requireAuth, requireAdmin, getBreakGlassRecords);
router.post("/admin/break-glass/:grantId/revoke", requireAuth, requireAdmin, closeBreakGlass);
router.get("/analytics/summary", requireAuth, getAnalyticsSummary);

export default router;
