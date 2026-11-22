import { generateAssist, isAssistantConfigured } from "./medicalAssistantService.js";
import { getRoomEntitlements } from "./entitlementService.js";
import { logError } from "../utils/logging.js";

export const FREE_ASSIST_LIMIT = 3;
// Enough new speech to be worth a run, and a floor between runs so a long
// consultation does not turn into a stream of model calls.
const MIN_NEW_CHARS = 180;
const MIN_INTERVAL_MS = 20 * 1000;

const rooms = new Map();

function ensure(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      lines: [],
      charsSinceRun: 0,
      lastRunAt: 0,
      running: false,
      assistsUsed: 0,
      limit: null,
      latest: null,
    });
  }
  return rooms.get(roomId);
}

export function recordAssistantLine(roomId, text) {
  const line = String(text || "").trim();
  if (!roomId || !line) return;
  const state = ensure(roomId);
  state.lines.push(line);
  state.charsSinceRun += line.length;
  // Only the recent conversation is needed; the full transcript is persisted.
  if (state.lines.length > 400) state.lines.splice(0, state.lines.length - 400);
}

async function resolveLimit(roomId, state) {
  if (state.limit !== null) return state.limit;
  try {
    const entitlements = await getRoomEntitlements(roomId);
    state.limit = entitlements?.paid ? Number.POSITIVE_INFINITY : FREE_ASSIST_LIMIT;
  } catch (err) {
    logError("assistant.entitlement_failed", err);
    state.limit = FREE_ASSIST_LIMIT;
  }
  return state.limit;
}

export function getAssistantState(roomId) {
  const state = rooms.get(roomId);
  if (!state) return { latest: null, assistsUsed: 0, limit: FREE_ASSIST_LIMIT };
  return {
    latest: state.latest,
    assistsUsed: state.assistsUsed,
    limit: state.limit === null ? FREE_ASSIST_LIMIT : state.limit,
  };
}

function quotaPayload(state, limit) {
  return {
    assistsUsed: state.assistsUsed,
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(limit) ? Math.max(0, limit - state.assistsUsed) : null,
  };
}

// Returns the payload to emit, or null when this turn should not run.
export async function maybeAssist(roomId, { language, force = false } = {}) {
  if (!roomId || !isAssistantConfigured()) return null;
  const state = ensure(roomId);
  if (state.running) return null;

  const limit = await resolveLimit(roomId, state);
  if (state.assistsUsed >= limit) return null;

  const now = Date.now();
  if (!force) {
    if (state.charsSinceRun < MIN_NEW_CHARS) return null;
    if (now - state.lastRunAt < MIN_INTERVAL_MS) return null;
  }
  if (!state.lines.length) return null;

  state.running = true;
  state.lastRunAt = now;
  state.charsSinceRun = 0;
  try {
    const result = await generateAssist(state.lines.join("\n"), { language });
    if (!result) return null;
    state.assistsUsed += 1;
    state.latest = result;
    return { ...result, ...quotaPayload(state, limit) };
  } catch (err) {
    logError("assistant.run_failed", err);
    return null;
  } finally {
    state.running = false;
  }
}

export function clearAssistant(roomId) {
  rooms.delete(roomId);
}

export function __resetAssistantState() {
  rooms.clear();
}
