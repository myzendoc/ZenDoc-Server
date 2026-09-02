#!/usr/bin/env node
// Disposes of soft-deleted PHI past its retention window. See docs/HIPAA.md.
//
//   node scripts/purgePhi.js status
//   node scripts/purgePhi.js purge --dry-run
//   node scripts/purgePhi.js purge
import mongoose from "mongoose";
import dotenv from "dotenv";
import { connectDatabase } from "../db.js";
import { getRetentionSummary, purgeExpiredRecords } from "../services/retentionService.js";
import { DisposalRecord } from "../models/disposalRecord.js";

dotenv.config();

async function status() {
  const { retentionDays, cutoff, rows } = await getRetentionSummary();
  console.log(`Retention: ${retentionDays} days (purging anything deleted before ${cutoff.toISOString()})\n`);
  for (const row of rows) {
    console.log(
      `${row.collection.padEnd(18)} live ${String(row.live).padStart(7)}   ` +
        `soft-deleted ${String(row.softDeleted).padStart(7)}   purgeable ${String(row.purgeable).padStart(7)}`
    );
  }
  const recent = await DisposalRecord.find({}).sort({ createdAt: -1 }).limit(5).lean();
  if (recent.length) {
    console.log("\nRecent disposals:");
    for (const record of recent) {
      console.log(
        `  ${record.createdAt.toISOString()}  ${record.collectionName.padEnd(16)} ` +
          `${String(record.documentCount).padStart(6)} docs  batch ${record.batchId}${record.dryRun ? "  (dry run)" : ""}`
      );
    }
  }
}

async function purge(dryRun) {
  const result = await purgeExpiredRecords({ dryRun, performedBy: process.env.USER || "cli" });
  console.log(`Batch ${result.batchId}${dryRun ? "  (dry run)" : ""}`);
  console.log(`Cutoff ${result.cutoff.toISOString()} (${result.retentionDays} day retention)\n`);
  let total = 0;
  for (const row of result.results) {
    total += row.purged;
    console.log(`${row.collection.padEnd(18)} ${dryRun ? "would purge" : "purged"} ${row.purged}`);
  }
  console.log(
    dryRun
      ? `\n${total} record(s) would be disposed of. A disposal record was written for each batch.`
      : `\n${total} record(s) disposed of.`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "status";
  const dryRun = args.includes("--dry-run");

  await connectDatabase();
  try {
    if (command === "status") await status();
    else if (command === "purge") await purge(dryRun);
    else {
      console.error("Usage: node scripts/purgePhi.js <status|purge> [--dry-run]");
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
