import {
  createScheduledMeeting,
  getMeeting,
  getMeetingById,
  listMeetingsForUser,
  listMeetingsWithCreators,
  getMeetingWithCreator,
} from "../services/meetingService.js";
import { createSoapNote, getSoapNotesByMeeting } from "../services/soapNoteService.js";
import { getTranscriptsByRoom } from "../services/transcriptService.js";

function computeStatus(meeting) {
  const now = new Date();
  if (meeting?.endedAt) return "ended";
  if (meeting?.startedAt) return "live";
  const scheduled = meeting?.scheduledFor ? new Date(meeting.scheduledFor) : null;
  if (scheduled && scheduled > now) return "scheduled";
  return "ready";
}

function buildClientBase(req) {
  const envBase = process.env.CLIENT_APP_URL?.replace(/\/$/, "");
  if (envBase) return envBase;
  if (req.headers?.origin) return req.headers.origin.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function serializeMeeting(meeting, req) {
  if (!meeting) return null;
  const status = computeStatus(meeting);
  const clientBase = buildClientBase(req);
  const joinLink = `${clientBase}/room/${meeting.roomId}`;
  return {
    ...meeting,
    status,
    joinLink,
  };
}

function canAccessMeeting(meeting, user) {
  if (!meeting || !user) return false;
  if (user.role === "admin") return true;
  if (meeting.createdBy && String(meeting.createdBy) === String(user._id)) return true;
  return false;
}

export async function createDashboardMeeting(req, res) {
  try {
    const { title, description, scheduledFor } = req.body || {};
    const meeting = await createScheduledMeeting({
      title,
      description,
      scheduledFor,
      createdBy: req.user?._id,
    });
    res.json({ meeting: serializeMeeting(meeting, req) });
  } catch (err) {
    res.status(400).json({ error: "Failed to create meeting" });
  }
}

export async function listDashboardMeetings(req, res) {
  try {
    const includeAll = req.user?.role === "admin";
    const meetings = await listMeetingsWithCreators(req.user?._id, includeAll);
    const enriched = meetings.map((item) => serializeMeeting(item, req));
    const active = enriched.filter((m) => m?.status !== "ended");
    const past = enriched.filter((m) => m?.status === "ended");
    res.json({ active, past });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch meetings" });
  }
}

export async function getDashboardMeeting(req, res) {
  try {
    const meeting = await getMeetingWithCreator(req.params.id);
    if (!meeting) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!canAccessMeeting(meeting, req.user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const notes = await getSoapNotesByMeeting(meeting._id);
    res.json({ meeting: serializeMeeting(meeting, req), notes });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch meeting" });
  }
}

export async function listNotesMeetings(req, res) {
  try {
    const includeAll = req.user?.role === "admin";
    const meetings = await listMeetingsWithCreators(req.user?._id, includeAll);
    res.json({ meetings: meetings.map((m) => serializeMeeting(m, req)) });
  } catch {
    res.status(500).json({ error: "Failed to fetch meetings" });
  }
}

export async function getNotesMeeting(req, res) {
  try {
    const meeting = await getMeetingWithCreator(req.params.id);
    if (!meeting) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!canAccessMeeting(meeting, req.user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const transcripts = await getTranscriptsByRoom(meeting.roomId);
    const notes = await getSoapNotesByMeeting(meeting._id);
    res.json({
      meeting: serializeMeeting(meeting, req),
      transcripts,
      notes,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch meeting data" });
  }
}

export async function createMeetingNote(req, res) {
  try {
    const meeting = await getMeetingById(req.params.id);
    if (!meeting) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!canAccessMeeting(meeting, req.user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const { content, summary } = req.body || {};
    const note = await createSoapNote({
      meetingId: meeting._id,
      roomId: meeting.roomId,
      content,
      summary,
      createdBy: req.user?._id,
    });
    res.json({ note });
  } catch (err) {
    res.status(400).json({ error: "Failed to save note" });
  }
}

export async function getMeetingNotes(req, res) {
  try {
    const meeting = await getMeetingById(req.params.id);
    if (!meeting) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!canAccessMeeting(meeting, req.user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const notes = await getSoapNotesByMeeting(meeting._id);
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch notes" });
  }
}

export async function getPublicMeeting(req, res) {
  try {
    const meeting = await getMeeting(req.params.roomId);
    if (!meeting) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({
      meeting: serializeMeeting(meeting, req),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch meeting" });
  }
}
