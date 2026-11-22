import mongoose from "mongoose";
import { softDeletePlugin } from "./plugins/softDelete.js";

const meetingSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    title: { type: String },
    description: { type: String },
    scheduledFor: { type: Date },
    startedAt: { type: Date },
    creatorPeerId: { type: String },
    creatorSocketId: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    endedAt: { type: Date },
    sessionsCount: { type: Number, default: 0 },
    currentSessionIndex: { type: Number },
    transcriptLanguage: { type: String, default: "auto" },
    // How the visit was captured; uploads are metered separately from calls.
    source: { type: String, enum: ["live", "voice_visit", "upload"], default: "live", index: true },
  },
  { timestamps: true }
);

meetingSchema.plugin(softDeletePlugin);

export const Meeting = mongoose.model("Meeting", meetingSchema);
