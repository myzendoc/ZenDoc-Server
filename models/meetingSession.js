import mongoose from "mongoose";

const meetingSessionSchema = new mongoose.Schema(
  {
    meetingId: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting", required: true, index: true },
    roomId: { type: String, required: true, index: true },
    title: { type: String },
    sessionIndex: { type: Number, required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date },
    creatorPeerId: { type: String },
    creatorSocketId: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

meetingSessionSchema.index({ meetingId: 1, sessionIndex: 1 }, { unique: true });

export const MeetingSession = mongoose.model("MeetingSession", meetingSessionSchema);
