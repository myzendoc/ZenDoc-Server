import mongoose from "mongoose";

// Emergency access grant (§164.312(a)(2)(ii)).
const breakGlassGrantSchema = new mongoose.Schema(
  {
    grantedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    grantedToEmail: { type: String },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    targetEmail: { type: String },
    reason: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date },
    accessCount: { type: Number, default: 0 },
    lastAccessedAt: { type: Date },
    notifiedAdminCount: { type: Number, default: 0 },
    ipAddress: { type: String },
  },
  { timestamps: true }
);

breakGlassGrantSchema.index({ createdAt: -1 });

export const BreakGlassGrant = mongoose.model("BreakGlassGrant", breakGlassGrantSchema);
