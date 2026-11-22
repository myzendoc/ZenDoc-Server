// Checks the in-call medical assistant: output shaping, free-tier gating and
// run cadence. The model and entitlements are stubbed.
// Run: node --experimental-test-module-mocks scripts/assistantCheck.mjs
import { mock } from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_CLOUD_PROJECT = "stub-project";

let modelReply = null;
let modelCalls = 0;
let lastRequest = null;
let paid = false;

mock.module("@google/genai", {
  namedExports: {
    Type: { OBJECT: "OBJECT", STRING: "STRING", ARRAY: "ARRAY", NUMBER: "NUMBER" },
    GoogleGenAI: class {
      constructor() {
        this.models = {
          generateContent: async (params) => {
            modelCalls += 1;
            lastRequest = params;
            return { text: JSON.stringify(modelReply) };
          },
        };
      }
    },
  },
});

mock.module("../services/entitlementService.js", {
  namedExports: {
    getRoomEntitlements: async () => ({ paid }),
    getUserEntitlements: async () => ({ paid }),
    isFreeSessionLimitExceeded: () => false,
    FREE_SOAP_TRANSCRIPT_LIMIT: 3,
    isPaidSubscriber: () => paid,
  },
});

const { generateAssist, ASSISTANT_DISCLAIMER } = await import("../services/medicalAssistantService.js");
const runner = await import("../services/assistantRunner.js");

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(["PASS", name]);
  } catch (err) {
    results.push(["FAIL", `${name} :: ${err.message}`]);
  }
};

const FULL_REPLY = {
  followUps: [
    { question: "Have you had a fever?", rationale: "Separates infective from mechanical causes" },
    { question: "When did the symptoms start?", rationale: "Onset shapes the differential" },
    { question: "Are you taking any medication?", rationale: "Interactions and masking effects" },
    { question: "Any family history?", rationale: "Risk stratification" },
    { question: "Fifth question", rationale: "Should be dropped" },
    { question: "Sixth question", rationale: "Should be dropped" },
  ],
  diagnostics: [
    { condition: "Prediabetes", confidence: 14, basis: "Borderline glucose" },
    { condition: "Type 2 diabetes", confidence: 78, basis: "Elevated glucose, thirst, fatigue" },
    { condition: "Thyroid dysfunction", confidence: 5, basis: "Fatigue and weight change" },
    { condition: "Fourth condition", confidence: 2, basis: "Should be dropped" },
  ],
};

const LONG_LINE = "The patient describes persistent thirst and fatigue over several weeks now. ".repeat(4);

modelReply = FULL_REPLY;
const shaped = await generateAssist("Patient transcript");

check("follow-up questions are capped at four", () => {
  assert.equal(shaped.followUps.length, 4);
  assert.equal(shaped.followUps[0].question, "Have you had a fever?");
});

check("diagnostic suggestions are capped at three", () => {
  assert.equal(shaped.diagnostics.length, 3);
});

check("diagnoses arrive ranked by confidence", () => {
  assert.deepEqual(
    shaped.diagnostics.map((item) => item.condition),
    ["Type 2 diabetes", "Prediabetes", "Thyroid dysfunction"]
  );
});

check("the prompt forbids inventing findings", () => {
  const instruction = lastRequest?.config?.systemInstruction || "";
  assert.ok(/Never invent/i.test(instruction));
  assert.ok(/current picture/i.test(instruction), "the self-correcting rule is missing");
});

modelReply = {
  followUps: [{ question: "  ", rationale: "blank" }, { question: "Real question", rationale: "" }],
  diagnostics: [
    { condition: "Sepsis", confidence: 140, basis: "x" },
    { condition: "Anaemia", confidence: -20, basis: "y" },
    { condition: "", confidence: 50, basis: "z" },
  ],
};
const cleaned = await generateAssist("Patient transcript");

check("blank questions and nameless conditions are dropped", () => {
  assert.equal(cleaned.followUps.length, 1);
  assert.equal(cleaned.followUps[0].question, "Real question");
  assert.equal(cleaned.diagnostics.length, 2);
});

check("confidence is clamped into 0-100", () => {
  const byName = Object.fromEntries(cleaned.diagnostics.map((item) => [item.condition, item.confidence]));
  assert.equal(byName.Sepsis, 100);
  assert.equal(byName.Anaemia, 0);
});

modelReply = { followUps: [], diagnostics: [] };
const empty = await generateAssist("Patient transcript");
check("an empty result is null rather than an empty panel", () => {
  assert.equal(empty, null);
});

const noTranscript = await generateAssist("   ");
check("no transcript means no model call", () => {
  assert.equal(noTranscript, null);
});

check("the disclaimer the client asked for is exported verbatim", () => {
  assert.equal(ASSISTANT_DISCLAIMER, "These are suggestions. AI can make mistakes, check important info.");
});

// ---- runner: cadence and gating ----
modelReply = FULL_REPLY;

runner.__resetAssistantState();
modelCalls = 0;
runner.recordAssistantLine("room-a", "Short line.");
const tooSoon = await runner.maybeAssist("room-a");
check("a few words do not trigger a model call", () => {
  assert.equal(tooSoon, null);
  assert.equal(modelCalls, 0);
});

runner.recordAssistantLine("room-a", LONG_LINE);
const firstRun = await runner.maybeAssist("room-a");
check("enough new speech triggers one run", () => {
  assert.ok(firstRun, "expected a result");
  assert.equal(modelCalls, 1);
  assert.equal(firstRun.followUps.length, 4);
});

runner.recordAssistantLine("room-a", LONG_LINE);
const throttled = await runner.maybeAssist("room-a");
check("a second run is throttled even with new speech", () => {
  assert.equal(throttled, null);
  assert.equal(modelCalls, 1, "the cooldown did not hold");
});

const forced = await runner.maybeAssist("room-a", { force: true });
check("the host can force an update through the cooldown", () => {
  assert.ok(forced);
  assert.equal(modelCalls, 2);
});

check("quota is reported back to a free user", () => {
  assert.equal(forced.limit, 3);
  assert.equal(forced.assistsUsed, 2);
  assert.equal(forced.remaining, 1);
});

const third = await runner.maybeAssist("room-a", { force: true });
check("the third assist is allowed", () => {
  assert.ok(third);
  assert.equal(third.remaining, 0);
});

modelCalls = 0;
const fourth = await runner.maybeAssist("room-a", { force: true });
check("GATING: a free user is cut off after three assists", () => {
  assert.equal(fourth, null);
  assert.equal(modelCalls, 0, "a model call was made past the free limit");
});

paid = true;
runner.__resetAssistantState();
modelCalls = 0;
runner.recordAssistantLine("room-b", LONG_LINE);
let lastPaid = null;
for (let i = 0; i < 6; i += 1) {
  lastPaid = await runner.maybeAssist("room-b", { force: true });
}
check("GATING: a paid user is not capped", () => {
  assert.equal(modelCalls, 6);
  assert.equal(lastPaid.limit, null, "a paid user should report no limit");
  assert.equal(lastPaid.remaining, null);
});

paid = false;
runner.__resetAssistantState();
runner.recordAssistantLine("room-c", LONG_LINE);
await runner.maybeAssist("room-c", { force: true });
check("state is readable for a panel opened later", () => {
  const state = runner.getAssistantState("room-c");
  assert.ok(state.latest, "the latest suggestions were not kept");
  assert.equal(state.assistsUsed, 1);
});

runner.clearAssistant("room-c");
check("ending the room drops its transcript from memory", () => {
  const state = runner.getAssistantState("room-c");
  assert.equal(state.latest, null);
  assert.equal(state.assistsUsed, 0);
});

const failures = results.filter(([status]) => status === "FAIL");
for (const [status, name] of results) console.log(`${status === "PASS" ? "✔" : "✖"} ${name}`);
console.log(`\n${results.length - failures.length}/${results.length} passed`);
process.exit(failures.length ? 1 : 0);
