import {
  createScheduledMeeting,
  getMeeting,
  getMeetingById,
  getMeetingWithCreator,
} from "../services/meetingService.js";
import {
  getMeetingSessionWithContext,
  listMeetingSessionsForMeeting,
  listMeetingSessionsWithContext,
} from "../services/meetingSessionService.js";
import { createSoapNote, getSoapNotesByMeeting, getSoapNotesBySession } from "../services/soapNoteService.js";
import { getTranscriptsByRoom } from "../services/transcriptService.js";

function computeStatus(session, meeting) {
  const now = new Date();
  if (session?.endedAt) return "ended";
  if (session?.startedAt) return "live";
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

function serializeSessionRecord(record, req) {
  if (!record) return null;
  const meeting = record.meeting || record;
  if (!meeting) return null;
  const status = computeStatus(record.sessionIndex !== undefined ? record : null, meeting);
  const clientBase = buildClientBase(req);
  const joinLink = `${clientBase}/room/${meeting.roomId}`;

  return {
    ...meeting,
    _id: record._id || meeting._id,
    meetingId: meeting._id,
    creatorPeerId: record.creatorPeerId || meeting.creatorPeerId,
    creatorSocketId: record.creatorSocketId || meeting.creatorSocketId,
    sessionIndex: record.sessionIndex,
    sessionStartedAt: record.startedAt || null,
    sessionEndedAt: record.endedAt || null,
    createdAt: record.startedAt || record.createdAt || meeting.createdAt,
    creator: record.creator || meeting.creator || null,
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

async function resolveSessionByParam(id) {
  const session = await getMeetingSessionWithContext(id);
  if (session) return session;

  const meeting = await getMeetingWithCreator(id);
  if (!meeting) return null;
  const sessions = await listMeetingSessionsForMeeting(meeting._id);
  if (!sessions.length) {
    return {
      _id: meeting._id,
      meetingId: meeting._id,
      roomId: meeting.roomId,
      sessionIndex: meeting.currentSessionIndex,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      createdAt: meeting.createdAt,
      meeting,
      creator: meeting.creator || null,
      fallbackMeeting: true,
    };
  }

  const latest = sessions[0];
  return {
    ...latest,
    meeting,
    creator: meeting.creator || null,
  };
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
    res.json({ meeting: serializeSessionRecord({ ...meeting, meeting }, req) });
  } catch (err) {
    res.status(400).json({ error: "Failed to create meeting" });
  }
}

export async function listDashboardMeetings(req, res) {
  try {
    const includeAll = req.user?.role === "admin";
    const sessions = await listMeetingSessionsWithContext(req.user?._id, includeAll);
    const enriched = sessions.map((item) => serializeSessionRecord(item, req));
    const active = enriched.filter((m) => m?.status !== "ended");
    const past = enriched.filter((m) => m?.status === "ended");
    res.json({ active, past });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch meetings" });
  }
}

export async function getDashboardMeeting(req, res) {
  try {
    const session = await resolveSessionByParam(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!canAccessMeeting(session.meeting, req.user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const notes = session.fallbackMeeting
      ? await getSoapNotesByMeeting(session.meeting._id)
      : await getSoapNotesBySession(session._id);
    res.json({ meeting: serializeSessionRecord(session, req), notes });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch meeting" });
  }
}

export async function listNotesMeetings(req, res) {
  try {
    const includeAll = req.user?.role === "admin";
    const sessions = await listMeetingSessionsWithContext(req.user?._id, includeAll);
    res.json({ meetings: sessions.map((s) => serializeSessionRecord(s, req)) });
  } catch {
    res.status(500).json({ error: "Failed to fetch meetings" });
  }
}

export async function getNotesMeeting(req, res) {
  try {
    const session = await resolveSessionByParam(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!canAccessMeeting(session.meeting, req.user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const transcripts = session.fallbackMeeting
      ? await getTranscriptsByRoom(session.meeting.roomId)
      : await getTranscriptsByRoom(session.meeting.roomId, {
          meetingSessionId: session._id,
          sessionIndex: session.sessionIndex,
        });

    const notes = session.fallbackMeeting
      ? await getSoapNotesByMeeting(session.meeting._id)
      : await getSoapNotesBySession(session._id);

    res.json({
      meeting: serializeSessionRecord(session, req),
      transcripts,
      notes,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch meeting data" });
  }
}

export async function createMeetingNote(req, res) {
  try {
    const session = await getMeetingSessionWithContext(req.params.id);
    if (session) {
      if (!canAccessMeeting(session.meeting, req.user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const { content, summary } = req.body || {};
      const note = await createSoapNote({
        meetingId: session.meeting._id,
        meetingSessionId: session._id,
        sessionIndex: session.sessionIndex,
        roomId: session.meeting.roomId,
        content,
        summary,
        createdBy: req.user?._id,
      });
      res.json({ note });
      return;
    }

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
    const session = await getMeetingSessionWithContext(req.params.id);
    if (session) {
      if (!canAccessMeeting(session.meeting, req.user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const notes = await getSoapNotesBySession(session._id);
      res.json({ notes });
      return;
    }

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
      meeting: serializeSessionRecord({ ...meeting, meeting }, req),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch meeting" });
  }
}
