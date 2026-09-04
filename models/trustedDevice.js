import mongoose from "mongoose";

// A device the user chose to trust, so the second factor is skipped there.
const trustedDeviceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, index: true, select: false },
    label: { type: String },
    userAgent: { type: String },
    ipAddress: { type: String },
    lastUsedAt: { type: Date },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

trustedDeviceSchema.index({ userId: 1, createdAt: -1 });

export const TrustedDevice = mongoose.model("TrustedDevice", trustedDeviceSchema);
