import mongoose from "mongoose";

const soapNoteSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    content: { type: Object, required: true },
    meetingId: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    summary: { type: String },
  },
  { timestamps: true }
);

export const SoapNote = mongoose.model("SoapNote", soapNoteSchema);
