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
  },
  { timestamps: true }
);

meetingSchema.plugin(softDeletePlugin);

export const Meeting = mongoose.model("Meeting", meetingSchema);
