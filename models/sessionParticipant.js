import mongoose from "mongoose";
import { softDeletePlugin } from "./plugins/softDelete.js";

// Who actually joined a visit. No display name is stored: patients type their
// own name, which would be PHI.
const sessionParticipantSchema = new mongoose.Schema(
  {
    meetingId: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting", index: true },
    meetingSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "MeetingSession", index: true },
    roomId: { type: String, required: true, index: true },
    sessionIndex: { type: Number, index: true },
    peerId: { type: String, required: true },
    role: { type: String, enum: ["creator", "admin", "guest"], default: "guest", index: true },
    joinedAt: { type: Date, required: true },
    leftAt: { type: Date },
  },
  { timestamps: true }
);

sessionParticipantSchema.index({ meetingSessionId: 1, peerId: 1 }, { unique: true, sparse: true });
sessionParticipantSchema.plugin(softDeletePlugin);

export const SessionParticipant = mongoose.model("SessionParticipant", sessionParticipantSchema);
