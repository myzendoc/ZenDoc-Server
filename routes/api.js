import express from "express";
import { createMeeting, fetchMeeting, fetchMeetings } from "../controllers/meetingController.js";
import { createSoap, fetchSoap, fetchSoaps } from "../controllers/soapNoteController.js";
import { signup, login, me, updateProfile, sendOtp, verifyOtp } from "../controllers/authController.js";
import {
  createDashboardMeeting,
  getDashboardMeeting,
  getMeetingNotes,
  getPublicMeeting,
  listDashboardMeetings,
  createMeetingNote,
} from "../controllers/dashboardController.js";
import { listUsers } from "../controllers/adminController.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.post("/auth/signup", signup);
router.post("/auth/login", login);
router.get("/auth/me", requireAuth, me);
router.post("/auth/profile", requireAuth, updateProfile);
router.post("/auth/send-otp", sendOtp);
router.post("/auth/verify-otp", verifyOtp);

router.post("/dashboard/meetings", requireAuth, createDashboardMeeting);
router.get("/dashboard/meetings", requireAuth, listDashboardMeetings);
router.get("/dashboard/meetings/:id", requireAuth, getDashboardMeeting);
router.post("/dashboard/meetings/:id/notes", requireAuth, createMeetingNote);
router.get("/dashboard/meetings/:id/notes", requireAuth, getMeetingNotes);

router.get("/public/meetings/:roomId", getPublicMeeting);

router.get("/admin/users", requireAuth, requireAdmin, listUsers);

router.post("/meetings", createMeeting);
router.get("/meetings", fetchMeetings);
router.get("/meetings/:roomId", fetchMeeting);

router.post("/soaps", createSoap);
router.get("/soaps/:roomId", fetchSoaps);
router.get("/soap/:id", fetchSoap);

export default router;
