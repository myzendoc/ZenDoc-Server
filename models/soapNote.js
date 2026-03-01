import mongoose from "mongoose";

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

export const SoapNote = mongoose.model("SoapNote", soapNoteSchema);
