import { Meeting } from "../models/meeting.js";
import { MeetingSession } from "../models/meetingSession.js";
import { User } from "../models/user.js";
import { Transcript } from "../models/transcript.js";
import { SoapNote } from "../models/soapNote.js";

export async function startMeetingSession({ roomId, creatorPeerId, creatorSocketId }) {
  if (!roomId) return null;
  const now = new Date();
  let meeting = await Meeting.findOne({ roomId });
  if (!meeting) {
    meeting = await Meeting.create({ roomId });
  }

  const nextIndex = (meeting.sessionsCount || 0) + 1;
  meeting.sessionsCount = nextIndex;
  meeting.currentSessionIndex = nextIndex;
  meeting.startedAt = now;
  meeting.endedAt = null;
  if (creatorPeerId !== undefined) meeting.creatorPeerId = creatorPeerId;
  if (creatorSocketId !== undefined) meeting.creatorSocketId = creatorSocketId;
  await meeting.save();

  const session = await MeetingSession.create({
    meetingId: meeting._id,
    roomId,
    title: meeting.title || "Meeting",
    sessionIndex: nextIndex,
    startedAt: now,
    creatorPeerId: creatorPeerId || meeting.creatorPeerId,
    creatorSocketId: creatorSocketId || meeting.creatorSocketId,
    createdBy: meeting.createdBy,
  });

  return {
    meeting: meeting.toObject(),
    session: session.toObject(),
  };
}

export async function endMeetingSession({ roomId, meetingSessionId, sessionIndex, endedAt }) {
  const endAt = endedAt || new Date();
  let session = null;
  if (meetingSessionId) {
    session = await MeetingSession.findById(meetingSessionId);
  }
  if (!session && roomId && sessionIndex) {
    session = await MeetingSession.findOne({ roomId, sessionIndex });
  }
  if (!session && roomId) {
    session = await MeetingSession.findOne({ roomId }).sort({ sessionIndex: -1 });
  }
  if (!session) return null;

  if (!session.endedAt) {
    session.endedAt = endAt;
    await session.save();
  }

  await Meeting.findByIdAndUpdate(session.meetingId, {
    $set: { endedAt: session.endedAt, currentSessionIndex: null },
  });

  return session.toObject();
}

export async function listMeetingSessionsWithContext(userId, includeAll = false) {
  const meetingFilter = includeAll ? {} : { createdBy: userId };
  const meetings = await Meeting.find(meetingFilter).lean();
  if (!meetings.length) return [];

  const meetingById = new Map(meetings.map((m) => [String(m._id), m]));
  const meetingIds = meetings.map((m) => m._id);
  const sessions = await MeetingSession.find({ meetingId: { $in: meetingIds } }).sort({ startedAt: -1, createdAt: -1 }).lean();

  const creatorIds = meetings.map((m) => m.createdBy).filter(Boolean);
  const creators = creatorIds.length ? await User.find({ _id: { $in: creatorIds } }).lean() : [];
  const creatorById = new Map(creators.map((u) => [String(u._id), u]));

  return sessions
    .map((session) => {
      const meeting = meetingById.get(String(session.meetingId));
      if (!meeting) return null;
      const creator = meeting.createdBy ? creatorById.get(String(meeting.createdBy)) || null : null;
      return { ...session, meeting, creator };
    })
    .filter(Boolean);
}

export async function getMeetingSessionWithContext(id) {
  if (!id) return null;
  const session = await MeetingSession.findById(id).lean();
  if (!session) return null;
  const meeting = await Meeting.findById(session.meetingId).lean();
  if (!meeting) return null;
  const creator = meeting.createdBy ? await User.findById(meeting.createdBy).lean() : null;
  return { ...session, meeting, creator };
}

export async function listMeetingSessionsForMeeting(meetingId) {
  if (!meetingId) return [];
  return MeetingSession.find({ meetingId }).sort({ sessionIndex: -1 }).lean();
}

export async function getLatestMeetingSessionForRoom(roomId) {
  if (!roomId) return null;
  return MeetingSession.findOne({ roomId }).sort({ sessionIndex: -1 }).lean();
}

export async function renameMeetingSession(sessionId, title) {
  if (!sessionId) return null;
  const nextTitle = String(title || "").trim();
  if (!nextTitle) throw new Error("Session title is required");
  return MeetingSession.findByIdAndUpdate(sessionId, { $set: { title: nextTitle } }, { new: true }).lean();
}

export async function deleteMeetingSessionWithData(sessionId) {
  if (!sessionId) return null;
  const session = await MeetingSession.findById(sessionId).lean();
  if (!session) return null;

  await Promise.all([
    Transcript.deleteMany({ meetingSessionId: session._id }),
    SoapNote.deleteMany({ meetingSessionId: session._id }),
    MeetingSession.deleteOne({ _id: session._id }),
  ]);

  const hasRemainingSessions = await MeetingSession.exists({ meetingId: session.meetingId });
  if (!hasRemainingSessions) {
    await Meeting.findByIdAndUpdate(session.meetingId, { $set: { currentSessionIndex: null, endedAt: null } });
  } else {
    const latest = await MeetingSession.findOne({ meetingId: session.meetingId }).sort({ sessionIndex: -1 }).lean();
    await Meeting.findByIdAndUpdate(session.meetingId, {
      $set: { currentSessionIndex: latest?.sessionIndex ?? null },
    });
  }

  return session;
}
