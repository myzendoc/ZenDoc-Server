import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
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
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorUserId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
