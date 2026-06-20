import mongoose from "mongoose";

const groupInviteSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true, lowercase: true, index: true },
    token: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ["pending", "accepted", "revoked"], default: "pending", index: true },
    invitedByName: { type: String },
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

export const GroupInvite = mongoose.model("GroupInvite", groupInviteSchema);
