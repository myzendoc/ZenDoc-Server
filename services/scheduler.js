import crypto from "crypto";
import { JobLock } from "../models/jobLock.js";
import { purgeExpiredRecords } from "./retentionService.js";
import { verifyAuditChain } from "./auditLogService.js";
import { isChainConfigured } from "../utils/auditChain.js";
import { User } from "../models/user.js";
import { sendAuditChainAlertEmail } from "../utils/mailer.js";
import { logError, logInfo } from "../utils/logging.js";

const INSTANCE_ID = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const HOUR_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
const LOCK_TTL_MS = 30 * 60 * 1000;

const timers = [];

function hoursFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function isSchedulerEnabled() {
  const flag = String(process.env.ENABLE_SCHEDULED_JOBS || "").trim().toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.NODE_ENV !== "development";
}

// Only the instance that wins the lease runs the job.
async function acquireLock(jobName, intervalMs) {
  const now = new Date();
  const dueBefore = new Date(now.getTime() - intervalMs + 60 * 1000);
  const lock = await JobLock.findOneAndUpdate(
    {
      _id: jobName,
      $or: [{ lockedUntil: { $lte: now } }, { lockedUntil: null }],
      $and: [{ $or: [{ lastRunAt: { $lte: dueBefore } }, { lastRunAt: null }] }],
    },
    { $set: { lockedUntil: new Date(now.getTime() + LOCK_TTL_MS), owner: INSTANCE_ID } },
    { new: true }
  );
  if (lock) return true;

  const existing = await JobLock.findById(jobName).lean();
  if (existing) return false;
  try {
    await JobLock.create({
      _id: jobName,
      lockedUntil: new Date(now.getTime() + LOCK_TTL_MS),
      owner: INSTANCE_ID,
    });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(jobName, status, error) {
  await JobLock.updateOne(
    { _id: jobName },
    {
      $set: {
        lockedUntil: new Date(0),
        lastRunAt: new Date(),
        lastStatus: status,
        lastError: error ? String(error).slice(0, 500) : undefined,
      },
    }
  );
}

async function runJob(jobName, intervalMs, task) {
  if (!(await acquireLock(jobName, intervalMs))) return;
  try {
    const result = await task();
    await releaseLock(jobName, "success");
    logInfo(`scheduler.${jobName}_completed`, result);
  } catch (err) {
    await releaseLock(jobName, "failure", err?.message);
    logError(`scheduler.${jobName}_failed`, err);
  }
}

async function purgeJob() {
  const result = await purgeExpiredRecords({ performedBy: "scheduler" });
  return { purged: result.results.reduce((total, row) => total + row.purged, 0), batchId: result.batchId };
}

async function auditVerifyJob() {
  if (!isChainConfigured()) return { skipped: "no chain secret" };
  const result = await verifyAuditChain();
  if (result.ok) return { checked: result.checked, ok: true };

  logError("audit.chain_integrity_failed", new Error(`${result.problems.length} problem(s) in the audit chain`));
  const admins = await User.find({ role: "admin", status: { $ne: "deactivated" } }).select("email").lean();
  await Promise.all(
    admins.map((admin) =>
      sendAuditChainAlertEmail({ email: admin.email, problems: result.problems, checked: result.checked }).catch(
        (err) => logError("audit.chain_alert_failed", err)
      )
    )
  );
  return { checked: result.checked, ok: false, problems: result.problems.length };
}

const JOBS = [
  { name: "phi-retention-purge", intervalHours: () => hoursFromEnv("PHI_PURGE_INTERVAL_HOURS", 24), task: purgeJob },
  { name: "audit-chain-verify", intervalHours: () => hoursFromEnv("AUDIT_VERIFY_INTERVAL_HOURS", 24), task: auditVerifyJob },
];

export function startScheduledJobs() {
  if (!isSchedulerEnabled()) {
    logInfo("scheduler.disabled", { reason: "ENABLE_SCHEDULED_JOBS" });
    return () => {};
  }

  for (const job of JOBS) {
    const intervalMs = job.intervalHours() * HOUR_MS;
    const tick = () => runJob(job.name, intervalMs, job.task).catch((err) => logError(`scheduler.${job.name}_tick`, err));
    // Delayed first run so boot is not competing with the job.
    timers.push(setTimeout(tick, STARTUP_DELAY_MS));
    timers.push(setInterval(tick, intervalMs));
    logInfo("scheduler.job_registered", { job: job.name, intervalHours: job.intervalHours() });
  }

  for (const timer of timers) timer.unref?.();
  return stopScheduledJobs;
}

export function stopScheduledJobs() {
  while (timers.length) {
    const timer = timers.pop();
    clearTimeout(timer);
    clearInterval(timer);
  }
}

export const __testAcquire = acquireLock;
export async function __testRunJob(jobName, intervalMs) {
  const job = JOBS.find((item) => item.name === jobName);
  await JobLock.updateOne({ _id: jobName }, { $set: { lockedUntil: new Date(0) }, $unset: { lastRunAt: 1 } });
  return runJob(jobName, intervalMs, job.task);
}

export async function getScheduledJobStatus() {
  const locks = await JobLock.find({}).lean();
  const byId = new Map(locks.map((lock) => [lock._id, lock]));
  return JOBS.map((job) => {
    const lock = byId.get(job.name);
    return {
      job: job.name,
      intervalHours: job.intervalHours(),
      lastRunAt: lock?.lastRunAt || null,
      lastStatus: lock?.lastStatus || "never_run",
      lastError: lock?.lastError || null,
    };
  });
}
