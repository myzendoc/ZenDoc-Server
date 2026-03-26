import {
  createScheduledMeeting,
  getMeeting,
  getMeetingById,
  getMeetingWithCreator,
} from "../services/meetingService.js";
import {
  deleteMeetingSessionWithData,
  getMeetingSessionWithContext,
  listMeetingSessionsForMeeting,
  listMeetingSessionsWithContext,
  renameMeetingSession,
} from "../services/meetingSessionService.js";
import { createSoapNote, getSoapNote, getSoapNotesByMeeting, getSoapNotesBySession, updateSoapNoteSection } from "../services/soapNoteService.js";
import { createPrivateNote, getPrivateNotesByMeeting, getPrivateNotesBySession } from "../services/privateNoteService.js";
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

function normalizeSessionTitle(sessionTitle, meetingTitle) {
  const legacySessionPattern = /^session\s+\d+$/i;
  const safeSessionTitle = typeof sessionTitle === "string" ? sessionTitle.trim() : "";
  const safeMeetingTitle = typeof meetingTitle === "string" ? meetingTitle.trim() : "";

  if (safeSessionTitle && !legacySessionPattern.test(safeSessionTitle)) return safeSessionTitle;
  if (safeMeetingTitle && safeMeetingTitle.toLowerCase() !== "untitled meeting") return safeMeetingTitle;
  return "Meeting";
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
    title: normalizeSessionTitle(record.title, meeting.title),
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
    const privateNotes = session.fallbackMeeting
      ? await getPrivateNotesByMeeting(session.meeting._id, { createdBy: req.user?._id })
      : await getPrivateNotesBySession(session._id, { createdBy: req.user?._id });

    const soapProcessing = !notes.length && transcripts.length > 0 && Boolean(session.endedAt || session?.meeting?.endedAt);

    res.json({
      meeting: serializeSessionRecord(session, req),
      transcripts,
      notes,
      privateNotes,
      soapProcessing,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch meeting data" });
  }
}

export async function createPrivateMeetingNote(req, res) {
  try {
    const content = String(req.body?.content || "").trim();
    if (!content) {
      res.status(400).json({ error: "Private note content is required" });
      return;
    }

    const session = await getMeetingSessionWithContext(req.params.id);
    if (session) {
      if (!canAccessMeeting(session.meeting, req.user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const note = await createPrivateNote({
        meetingId: session.meeting._id,
        meetingSessionId: session._id,
        sessionIndex: session.sessionIndex,
        roomId: session.meeting.roomId,
        content,
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
    const note = await createPrivateNote({
      meetingId: meeting._id,
      roomId: meeting.roomId,
      content,
      createdBy: req.user?._id,
    });
    res.json({ note });
  } catch {
    res.status(400).json({ error: "Failed to save private note" });
  }
}

export async function getPrivateMeetingNotes(req, res) {
  try {
    const session = await getMeetingSessionWithContext(req.params.id);
    if (session) {
      if (!canAccessMeeting(session.meeting, req.user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const notes = await getPrivateNotesBySession(session._id, { createdBy: req.user?._id });
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
    const notes = await getPrivateNotesByMeeting(meeting._id, { createdBy: req.user?._id });
    res.json({ notes });
  } catch {
    res.status(500).json({ error: "Failed to fetch private notes" });
  }
}

export async function renameNotesMeeting(req, res) {
  try {
    const session = await getMeetingSessionWithContext(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!canAccessMeeting(session.meeting, req.user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const title = String(req.body?.title || "").trim();
    if (!title) {
      res.status(400).json({ error: "Session title is required" });
      return;
    }
    const updated = await renameMeetingSession(session._id, title);
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const refreshed = await getMeetingSessionWithContext(session._id);
    res.json({ meeting: serializeSessionRecord(refreshed, req) });
  } catch {
    res.status(400).json({ error: "Failed to rename meeting session" });
  }
}

export async function deleteNotesMeeting(req, res) {
  try {
    const session = await getMeetingSessionWithContext(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!canAccessMeeting(session.meeting, req.user)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    await deleteMeetingSessionWithData(session._id);
    res.json({ status: "ok" });
  } catch {
    res.status(400).json({ error: "Failed to delete meeting session" });
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

export async function updateMeetingNote(req, res) {
  try {
    const section = String(req.body?.section || "").trim().toLowerCase();
    const content = String(req.body?.content || "").trim();
    if (!section || !["subjective", "objective", "assessment", "plan"].includes(section)) {
      res.status(400).json({ error: "Valid SOAP section is required" });
      return;
    }
    if (!content) {
      res.status(400).json({ error: "Section content is required" });
      return;
    }

    const session = await getMeetingSessionWithContext(req.params.id);
    if (session) {
      if (!canAccessMeeting(session.meeting, req.user)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const existing = await getSoapNote(req.params.noteId);
      if (!existing || String(existing.meetingSessionId || "") !== String(session._id)) {
        res.status(404).json({ error: "Note not found" });
        return;
      }
      const note = await updateSoapNoteSection(req.params.noteId, section, content);
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

    const existing = await getSoapNote(req.params.noteId);
    if (!existing || String(existing.meetingId || "") !== String(meeting._id)) {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    const note = await updateSoapNoteSection(req.params.noteId, section, content);
    res.json({ note });
  } catch {
    res.status(400).json({ error: "Failed to update note" });
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
