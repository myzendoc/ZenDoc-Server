import mongoose from "mongoose";

const transcriptSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    peerId: { type: String },
    text: { type: String, required: true },
  },
  { timestamps: true }
);

export const Transcript = mongoose.model("Transcript", transcriptSchema);
