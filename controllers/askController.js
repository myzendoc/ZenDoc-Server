import mongoose from "mongoose";
import { askQuestion, getAskStatus, isAskConfigured } from "../services/askService.js";
import { getMeetingById } from "../services/meetingService.js";
import { getMeetingSessionWithContext } from "../services/meetingSessionService.js";
import { getCountryFromRequest, getIpFromRequest } from "../utils/audit.js";
import { sendErrorResponse } from "../utils/errors.js";

function requestContext(req) {
  return {
    ipAddress: getIpFromRequest(req),
    country: getCountryFromRequest(req),
    userAgent: String(req.headers?.["user-agent"] || ""),
  };
}

export async function askAcrossRecords(req, res) {
  try {
    const result = await askQuestion({
      question: req.body?.question,
      actor: req.user,
      request: requestContext(req),
    });
    if (result?.error) {
      res.status(result.status || 400).json({ error: result.error });
      return;
    }
    res.json(result);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "AI search failed", status: 500, event: "ask.search_failed" });
  }
}

// The id is a session id in the notes UI and a meeting id for older records,
// so both resolve here. A malformed id is simply not found.
async function resolveScope(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const session = await getMeetingSessionWithContext(id);
  if (session?.meeting) {
    return { owner: session.meeting.createdBy, meetingSessionId: session._id };
  }
  const meeting = await getMeetingById(id);
  if (meeting) return { owner: meeting.createdBy, meetingId: meeting._id };
  return null;
}

export async function askAboutMeeting(req, res) {
  try {
    const scope = await resolveScope(req.params.meetingId);
    // A wrong or foreign id is a 404 rather than an empty answer.
    if (!scope || String(scope.owner) !== String(req.user?._id)) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    const result = await askQuestion({
      question: req.body?.question,
      actor: req.user,
      meetingId: scope.meetingId,
      meetingSessionId: scope.meetingSessionId,
      request: requestContext(req),
    });
    if (result?.error) {
      res.status(result.status || 400).json({ error: result.error });
      return;
    }
    res.json(result);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "AI search failed", status: 500, event: "ask.note_failed" });
  }
}

export async function fetchAskStatus(req, res) {
  try {
    res.json(await getAskStatus(req.user?._id));
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to load search status", status: 500, event: "ask.status_failed" });
  }
}

export function askConfigured(_req, res, next) {
  if (!isAskConfigured()) {
    res.status(503).json({ error: "AI search is not configured on this server" });
    return;
  }
  next();
}
