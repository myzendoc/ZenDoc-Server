import mongoose from "mongoose";

// Lease lock so only one instance runs a scheduled job.
const jobLockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    lockedUntil: { type: Date, required: true },
    owner: { type: String },
    lastRunAt: { type: Date },
    lastStatus: { type: String },
    lastError: { type: String },
  },
  { timestamps: true, versionKey: false }
);

export const JobLock = mongoose.model("JobLock", jobLockSchema);
