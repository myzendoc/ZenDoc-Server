import mongoose from "mongoose";

// Evidence of PHI disposal (§164.310(d)(2)(i)). Records ids and counts, never content.
const disposalRecordSchema = new mongoose.Schema(
  {
    batchId: { type: String, required: true, index: true },
    collectionName: { type: String, required: true, index: true },
    documentIds: { type: [String], default: [] },
    documentCount: { type: Number, required: true },
    earliestDeletedAt: { type: Date },
    latestDeletedAt: { type: Date },
    retentionDays: { type: Number, required: true },
    method: { type: String, enum: ["retention_purge", "manual_purge"], default: "retention_purge" },
    performedBy: { type: String, default: "system" },
    dryRun: { type: Boolean, default: false },
  },
  { timestamps: true }
);

disposalRecordSchema.index({ createdAt: -1 });

export const DisposalRecord = mongoose.model("DisposalRecord", disposalRecordSchema);
