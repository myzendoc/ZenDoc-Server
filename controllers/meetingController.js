import { getMeeting, listMeetings, upsertMeeting } from "../services/meetingService.js";

export async function createMeeting(req, res) {
  try {
    const { roomId, creatorPeerId, creatorSocketId } = req.body || {};
    const meeting = await upsertMeeting({ roomId, creatorPeerId, creatorSocketId });
    res.json(meeting);
  } catch (err) {
    res.status(500).json({ error: "Failed to create meeting" });
  }
}

export async function fetchMeetings(req, res) {
  try {
    const meetings = await listMeetings();
    res.json(meetings);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch meetings" });
  }
}

export async function fetchMeeting(req, res) {
  try {
    const meeting = await getMeeting(req.params.roomId);
    if (!meeting) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(meeting);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch meeting" });
  }
}
