import mongoose from "mongoose";

const soapNoteSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    content: { type: Object, required: true },
  },
  { timestamps: true }
);

export const SoapNote = mongoose.model("SoapNote", soapNoteSchema);
