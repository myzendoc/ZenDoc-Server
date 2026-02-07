import { randomUUID } from "crypto";
import { Meeting } from "../models/meeting.js";
import { User } from "../models/user.js";

export async function upsertMeeting({ roomId, creatorPeerId, creatorSocketId }) {
  if (!roomId) return null;
  const now = new Date();
  const meeting = await Meeting.findOneAndUpdate(
    { roomId },
    {
      $setOnInsert: { roomId, startedAt: now },
      $set: { creatorPeerId, creatorSocketId },
    },
    { new: true, upsert: true }
  );
  if (!meeting.startedAt) {
    meeting.startedAt = now;
    await meeting.save();
  }
  return meeting;
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

export async function createScheduledMeeting({ title, description, scheduledFor, createdBy }) {
  const roomId = randomUUID();
  const scheduled = scheduledFor ? new Date(scheduledFor) : null;
  const validDate = scheduled && !Number.isNaN(scheduled.getTime()) ? scheduled : null;
  const meeting = await Meeting.create({
    roomId,
    title: title || "Untitled meeting",
    description,
    scheduledFor: validDate,
    createdBy,
  });
  return meeting.toObject();
}

export async function listMeetingsForUser(userId, includeAll = false) {
  const filter = includeAll ? {} : { createdBy: userId };
  return Meeting.find(filter).sort({ createdAt: -1 }).lean();
}

export async function getMeetingById(id) {
  if (!id) return null;
  return Meeting.findById(id).lean();
}

export async function listMeetingsWithCreators(userId, includeAll = false) {
  const filter = includeAll ? {} : { createdBy: userId };
  const meetings = await Meeting.find(filter).sort({ createdAt: -1 }).lean();
  const creatorIds = meetings.map((m) => m.createdBy).filter(Boolean);
  const creators = await User.find({ _id: { $in: creatorIds } }).lean();
  const map = new Map(creators.map((u) => [String(u._id), u]));
  return meetings.map((m) => ({ ...m, creator: m.createdBy ? map.get(String(m.createdBy)) : null }));
}

export async function getMeetingWithCreator(id) {
  if (!id) return null;
  const meeting = await Meeting.findById(id).lean();
  if (!meeting) return null;
  const creator = meeting.createdBy ? await User.findById(meeting.createdBy).lean() : null;
  return { ...meeting, creator };
}
