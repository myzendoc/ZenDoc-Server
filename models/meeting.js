import mongoose from "mongoose";

const meetingSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    creatorPeerId: { type: String },
    creatorSocketId: { type: String },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

export const Meeting = mongoose.model("Meeting", meetingSchema);
