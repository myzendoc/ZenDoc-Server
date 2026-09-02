import crypto from "crypto";
import { Transcript } from "../models/transcript.js";
import { SoapNote } from "../models/soapNote.js";
import { PrivateNote } from "../models/privateNote.js";
import { MeetingSession } from "../models/meetingSession.js";
import { Meeting } from "../models/meeting.js";
import { DisposalRecord } from "../models/disposalRecord.js";
import { getRetentionCutoff, getRetentionDays } from "../models/plugins/softDelete.js";

// Children before parents, so an interrupted run leaves consistent data.
const PURGE_TARGETS = [
  { name: "transcripts", model: Transcript },
  { name: "soapnotes", model: SoapNote },
  { name: "privatenotes", model: PrivateNote },
  { name: "meetingsessions", model: MeetingSession },
  { name: "meetings", model: Meeting },
];

const PURGE_BATCH_SIZE = 500;

export function listPurgeTargets() {
  return PURGE_TARGETS.map((target) => target.name);
}

export async function getRetentionSummary() {
  const cutoff = getRetentionCutoff();
  const rows = [];
  for (const { name, model } of PURGE_TARGETS) {
    const [live, softDeleted, purgeable] = await Promise.all([
      model.countDocuments({}),
      model.countDocuments({ deletedAt: { $ne: null } }).setOptions({ includeDeleted: true }),
      model.countDocuments({ deletedAt: { $ne: null, $lte: cutoff } }).setOptions({ includeDeleted: true }),
    ]);
    rows.push({ collection: name, live, softDeleted, purgeable });
  }
  return { retentionDays: getRetentionDays(), cutoff, rows };
}

// Disposal record is written before the delete:
export async function purgeExpiredRecords({ dryRun = false, performedBy = "system" } = {}) {
  const cutoff = getRetentionCutoff();
  const retentionDays = getRetentionDays();
  const batchId = crypto.randomUUID();
  const results = [];

  for (const { name, model } of PURGE_TARGETS) {
    let purged = 0;
    for (;;) {
      const expired = await model
        .find({ deletedAt: { $ne: null, $lte: cutoff } })
        .select("_id deletedAt")
        .limit(PURGE_BATCH_SIZE)
        .setOptions({ includeDeleted: true })
        .lean();
      if (!expired.length) break;

      const ids = expired.map((doc) => doc._id);
      const timestamps = expired.map((doc) => new Date(doc.deletedAt).getTime());
      await DisposalRecord.create({
        batchId,
        collectionName: name,
        documentIds: ids.map(String),
        documentCount: ids.length,
        earliestDeletedAt: new Date(Math.min(...timestamps)),
        latestDeletedAt: new Date(Math.max(...timestamps)),
        retentionDays,
        method: "retention_purge",
        performedBy,
        dryRun,
      });

      if (dryRun) {
        purged += ids.length;
        break;
      }

      await model.deleteMany({ _id: { $in: ids } }).setOptions({ includeDeleted: true });
      purged += ids.length;
    }
    results.push({ collection: name, purged });
  }

  return { batchId, cutoff, retentionDays, dryRun, results };
}
