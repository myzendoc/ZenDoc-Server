import mongoose from "mongoose";

const authSessionSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, sparse: true },
    role: { type: String, enum: ["provider", "admin"], required: true },
    refreshTokenHash: { type: String, required: true, select: false },
    lastActivityAt: { type: Date, required: true, index: true },
    absoluteExpiresAt: { type: Date, required: true, index: { expires: 0 } },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

export const AuthSession = mongoose.model("AuthSession", authSessionSchema);
