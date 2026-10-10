import { SessionParticipant } from "../models/sessionParticipant.js";

export async function recordParticipantJoin({ roomId, meetingId, meetingSessionId, sessionIndex, peerId, role }) {
  if (!roomId || !peerId || !meetingSessionId) return null;
  return SessionParticipant.findOneAndUpdate(
    { meetingSessionId, peerId },
    {
      $setOnInsert: {
        roomId,
        meetingId,
        meetingSessionId,
        sessionIndex,
        peerId,
        role: role || "guest",
        joinedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

export async function recordParticipantLeave({ meetingSessionId, peerId }) {
  if (!meetingSessionId || !peerId) return null;
  return SessionParticipant.findOneAndUpdate(
    { meetingSessionId, peerId, leftAt: null },
    { $set: { leftAt: new Date() } }
  );
}

// Unique patients per visit, keyed `${roomId}:${sessionIndex}`. Providers are
// excluded: the client asked for the number of patients who attended.
export async function getPatientCountsBySession(meetingSessionIds = []) {
  if (!meetingSessionIds.length) return {};
  const rows = await SessionParticipant.aggregate([
    { $match: { meetingSessionId: { $in: meetingSessionIds }, role: "guest" } },
    { $group: { _id: { session: "$meetingSessionId", peer: "$peerId" } } },
    { $group: { _id: "$_id.session", count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((row) => [String(row._id), row.count]));
}
