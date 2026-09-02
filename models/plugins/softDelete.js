// Soft deletion for PHI collections.
import mongoose from "mongoose";

// Retention runs from deletion, not creation.
export const DEFAULT_RETENTION_DAYS = 6 * 365 + 1;

export function getRetentionDays() {
  const configured = Number(process.env.PHI_RETENTION_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RETENTION_DAYS;
}

export function getRetentionCutoff(now = Date.now()) {
  return new Date(now - getRetentionDays() * 24 * 60 * 60 * 1000);
}

// Opt in to deleted rows with .setOptions({ includeDeleted: true }).
const READ_HOOKS = [
  "count",
  "countDocuments",
  "find",
  "findOne",
  "findOneAndDelete",
  "findOneAndReplace",
  "findOneAndUpdate",
  "updateMany",
  "updateOne",
];

function excludeDeleted(next) {
  if (this.getOptions?.().includeDeleted) {
    next();
    return;
  }
  const filter = this.getFilter();
  if (!Object.prototype.hasOwnProperty.call(filter, "deletedAt")) {
    this.where({ deletedAt: null });
  }
  next();
}

export function softDeletePlugin(schema) {
  schema.add({
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    deletionReason: { type: String },
  });

  for (const hook of READ_HOOKS) {
    schema.pre(hook, excludeDeleted);
  }

  schema.pre("aggregate", function aggregateExcludeDeleted(next) {
    if (this.options?.includeDeleted) {
      next();
      return;
    }
    this.pipeline().unshift({ $match: { deletedAt: null } });
    next();
  });

  schema.statics.softDelete = function softDelete(filter, { actorId, reason } = {}) {
    return this.updateMany(filter, {
      $set: {
        deletedAt: new Date(),
        deletedBy: actorId || null,
        deletionReason: String(reason || "").slice(0, 500) || undefined,
      },
    });
  };

  schema.statics.restoreDeleted = function restoreDeleted(filter) {
    return this.updateMany(filter, {
      $set: { deletedAt: null, deletedBy: null },
      $unset: { deletionReason: 1 },
    }).setOptions({ includeDeleted: true });
  };
}
