import express from "express";
import { createMeeting, fetchMeeting, fetchMeetings } from "../controllers/meetingController.js";
import { createSoap, fetchSoap, fetchSoaps } from "../controllers/soapNoteController.js";

const router = express.Router();

router.post("/meetings", createMeeting);
router.get("/meetings", fetchMeetings);
router.get("/meetings/:roomId", fetchMeeting);

router.post("/soaps", createSoap);
router.get("/soaps/:roomId", fetchSoaps);
router.get("/soap/:id", fetchSoap);

export default router;
