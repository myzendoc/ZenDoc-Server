import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, sparse: true, index: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    actorSubject: { type: String, index: true },
    actorRole: { type: String, enum: ["admin", "provider", "guest"], default: "guest", index: true },
    actorEmail: { type: String, index: true },
    actorName: { type: String },
    action: { type: String, required: true, index: true },
    resourceType: { type: String, index: true },
    resourceId: { type: String, index: true },
    status: { type: String, enum: ["success", "failure"], required: true, index: true },
    ipAddress: { type: String, index: true },
    country: { type: String, index: true },
    userAgent: { type: String },
    browser: { type: String, index: true },
    method: { type: String, index: true },
    path: { type: String, index: true },
    metadata: { type: Object },
    // Tamper-evidence chain. Absent on records written before this was added.
    sequence: { type: Number, index: true, sparse: true },
    previousHash: { type: String },
    entryHash: { type: String, index: true, sparse: true },
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorUserId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
