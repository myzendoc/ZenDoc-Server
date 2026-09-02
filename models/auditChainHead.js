import mongoose from "mongoose";

// Single row holding the tip of the audit hash chain.
const auditChainHeadSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "audit" },
    sequence: { type: Number, required: true, default: 0 },
    lastHash: { type: String, required: true, default: "" },
  },
  { timestamps: true, versionKey: false }
);

export const AuditChainHead = mongoose.model("AuditChainHead", auditChainHeadSchema);
