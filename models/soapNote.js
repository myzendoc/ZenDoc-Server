import mongoose from "mongoose";
import { softDeletePlugin } from "./plugins/softDelete.js";

const soapNoteSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    content: { type: Object, required: true },
    meetingId: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting" },
    meetingSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "MeetingSession", index: true },
    sessionIndex: { type: Number, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    summary: { type: String },
  },
  { timestamps: true }
);

soapNoteSchema.plugin(softDeletePlugin);

export const SoapNote = mongoose.model("SoapNote", soapNoteSchema);
