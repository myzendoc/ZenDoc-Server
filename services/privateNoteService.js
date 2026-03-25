import { PrivateNote } from "../models/privateNote.js";

export async function createPrivateNote(payload) {
  return PrivateNote.create(payload);
}

export async function getPrivateNotesByMeeting(meetingId, options = {}) {
  if (!meetingId) return [];
  const query = { meetingId };
  if (options.createdBy) query.createdBy = options.createdBy;
  return PrivateNote.find(query).sort({ createdAt: -1 }).lean();
}

export async function getPrivateNotesBySession(meetingSessionId, options = {}) {
  if (!meetingSessionId) return [];
  const query = { meetingSessionId };
  if (options.createdBy) query.createdBy = options.createdBy;
  return PrivateNote.find(query).sort({ createdAt: -1 }).lean();
}
