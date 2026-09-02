#!/usr/bin/env node
// Verifies the audit log hash chain. Run on a schedule; see docs/HIPAA.md.
//
//   node scripts/verifyAuditChain.js [--from 2026-01-01] [--to 2026-12-31]
import mongoose from "mongoose";
import dotenv from "dotenv";
import { connectDatabase } from "../db.js";
import { verifyAuditChain } from "../services/auditLogService.js";
import { isChainConfigured } from "../utils/auditChain.js";

dotenv.config();

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    args[key] = !next || next.startsWith("--") ? true : next;
    if (args[key] !== true) i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!isChainConfigured()) {
    console.error("AUDIT_CHAIN_SECRET (or JWT_SECRET) is not set; nothing to verify against");
    process.exitCode = 1;
    return;
  }

  await connectDatabase();
  try {
    const result = await verifyAuditChain({ from: args.from, to: args.to });
    console.log(`Checked ${result.checked} chained entries`);
    if (result.unchained) {
      console.log(`${result.unchained} entry(ies) predate chaining and were skipped`);
    }
    if (result.ok) {
      console.log("\nChain intact — no gaps, broken links, or altered entries.");
      return;
    }
    console.log(`\n${result.problems.length} problem(s) found:\n`);
    for (const problem of result.problems.slice(0, 50)) {
      console.log(`  ${problem.type.padEnd(13)} sequence ${problem.sequence ?? problem.foundSequence}  event ${problem.eventId}`);
    }
    if (result.problems.length > 50) console.log(`  ... and ${result.problems.length - 50} more`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
