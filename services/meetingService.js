import { Meeting } from "../models/meeting.js";

export async function upsertMeeting({ roomId, creatorPeerId, creatorSocketId }) {
  if (!roomId) return null;
  return Meeting.findOneAndUpdate(
    { roomId },
    {
      $setOnInsert: { roomId },
      $set: { creatorPeerId, creatorSocketId },
    },
    { new: true, upsert: true }
  );
}

export async function endMeeting(roomId) {
  if (!roomId) return null;
  return Meeting.findOneAndUpdate(
    { roomId },
    { endedAt: new Date() },
    { new: true }
  );
}

export async function listMeetings() {
  return Meeting.find({}).sort({ createdAt: -1 }).lean();
}

export async function getMeeting(roomId) {
  if (!roomId) return null;
  return Meeting.findOne({ roomId }).lean();
}
