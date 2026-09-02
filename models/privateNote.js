import mongoose from "mongoose";
import { softDeletePlugin } from "./plugins/softDelete.js";

const privateNoteSchema = new mongoose.Schema(
  {
    meetingId: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting", required: true, index: true },
    meetingSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "MeetingSession", index: true },
    roomId: { type: String, required: true, index: true },
    sessionIndex: { type: Number },
    content: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

privateNoteSchema.index({ meetingId: 1, createdAt: -1 });
privateNoteSchema.index({ meetingSessionId: 1, createdAt: -1 });

privateNoteSchema.plugin(softDeletePlugin);

export const PrivateNote = mongoose.model("PrivateNote", privateNoteSchema);
