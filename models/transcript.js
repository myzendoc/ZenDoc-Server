import mongoose from "mongoose";

const transcriptSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    peerId: { type: String },
    sessionIndex: { type: Number, index: true },
    meetingSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "MeetingSession", index: true },
    text: { type: String, required: true },
  },
  { timestamps: true }
);

export const Transcript = mongoose.model("Transcript", transcriptSchema);
