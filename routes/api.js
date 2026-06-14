import express from "express";
import passport, { isGoogleAuthEnabled } from "../config/passport.js";
import { createMeeting, fetchMeeting, fetchMeetings } from "../controllers/meetingController.js";
import { createSoap, fetchSoap, fetchSoaps } from "../controllers/soapNoteController.js";
import { signup, login, me, updateProfile, sendOtp, verifyOtp, forgotPassword, resetPassword, googleCallback, googleFailure } from "../controllers/authController.js";
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
import { getAdminAuditLogs, getAdminDashboard, listUsers } from "../controllers/adminController.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { getAnalyticsSummary } from "../controllers/analyticsController.js";
import {
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
  listBillingPlans,
} from "../controllers/billingController.js";

const router = express.Router();

router.post("/auth/signup", signup);
router.post("/auth/login", login);
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
router.post("/auth/send-otp", sendOtp);
router.post("/auth/verify-otp", verifyOtp);
router.post("/auth/forgot-password", forgotPassword);
router.post("/auth/reset-password", resetPassword);
router.get("/billing/plans", listBillingPlans);
router.post("/billing/checkout-session", requireAuth, createCheckoutSession);
router.get("/billing/status", requireAuth, getBillingStatus);
router.post("/billing/portal-session", requireAuth, createPortalSession);

router.post("/dashboard/meetings", requireAuth, createDashboardMeeting);
router.get("/dashboard/meetings", requireAuth, listDashboardMeetings);
router.post("/dashboard/meetings/:roomId/invitations", requireAuth, invitePatientToMeeting);
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
router.get("/admin/dashboard", requireAuth, requireAdmin, getAdminDashboard);
router.get("/admin/audit-logs", requireAuth, requireAdmin, getAdminAuditLogs);
router.get("/analytics/summary", requireAuth, getAnalyticsSummary);

router.post("/meetings", createMeeting);
router.get("/meetings", fetchMeetings);
router.get("/meetings/:roomId", fetchMeeting);

router.post("/soaps", createSoap);
router.get("/soaps/:roomId", fetchSoaps);
router.get("/soap/:id", fetchSoap);

export default router;
