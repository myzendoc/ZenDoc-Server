// Verifies note generation: language instruction, every template's schema and
// sections, and visit titles. The SDK is stubbed so nothing leaves the machine.
// Run: node --experimental-test-module-mocks scripts/noteGenerationCheck.mjs
import { mock } from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_CLOUD_PROJECT = "stub-project";

const calls = [];
const constructions = [];
let nextPlainText = "";

mock.module("@google/genai", {
  defaultExport: {},
  namedExports: {
    Type: { OBJECT: "OBJECT", STRING: "STRING" },
    GoogleGenAI: class {
      constructor(options) {
        constructions.push(options);
        this.models = {
          generateContent: async (params) => {
            calls.push({ params });
            const schema = params?.config?.responseSchema;
            if (!schema) return { text: nextPlainText };
            const body = Object.fromEntries(
              Object.keys(schema.properties || {}).map((key) => [key, `<p>${key} content</p>`])
            );
            // An extra key the model should never be trusted to return.
            body.injected = "<p>should be dropped</p>";
            return { text: JSON.stringify(body) };
          },
        };
      }
    },
  },
});

const { generateSoaps, generateClinicalNote, generateVisitTitle, getSoapAuthMode } = await import("../services/soapsService.js");
const { listNoteTemplates, getTemplateSectionKeys } = await import("../utils/noteTemplates.js");

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(["PASS", name]);
  } catch (err) {
    results.push(["FAIL", `${name} :: ${err.message}`]);
  }
};

function lastInstruction() {
  const generate = [...calls].reverse().find((entry) => entry.params);
  return generate?.params?.config?.systemInstruction || "";
}

await generateSoaps("Patient reports a headache.", { language: "es" });
check("a Spanish consultation asks for a Spanish note", () => {
  const instruction = lastInstruction();
  assert.ok(instruction.includes("in Spanish"), "the Spanish instruction was not sent");
  assert.ok(instruction.includes("Do not translate the transcript into English"), "missing the no-translation rule");
  assert.ok(instruction.includes("SOAP note"), "the base instruction was dropped");
});

check("clinical identifiers are kept untranslated", () => {
  const instruction = lastInstruction();
  assert.ok(/drug names, dosages, lab names and ICD\/CPT codes/.test(instruction));
});

calls.length = 0;
await generateSoaps("Patient reports a headache.", { language: "en" });
check("an English consultation adds no language instruction", () => {
  const instruction = lastInstruction();
  assert.ok(!instruction.includes("in English"), "a redundant instruction was added");
  assert.ok(instruction.includes("SOAP note"), "the base instruction was dropped");
});

calls.length = 0;
await generateSoaps("Patient reports a headache.");
check("an unspecified language behaves like English", () => {
  assert.ok(!/Write every section of the note in/.test(lastInstruction()));
});

calls.length = 0;
await generateSoaps("Le patient signale des maux de tête.", { language: "fr" });
check("French routes through the same path", () => {
  assert.ok(lastInstruction().includes("in French"));
});

calls.length = 0;
await generateSoaps("x", { language: "klingon" });
check("an unknown language code is ignored rather than passed through", () => {
  const instruction = lastInstruction();
  assert.ok(!instruction.includes("klingon"), "an unvalidated code reached the prompt");
  assert.ok(!/Write every section of the note in/.test(instruction));
});

const structured = await generateSoaps("x", { language: "ja" });
check("the response still parses into the four SOAP sections", () => {
  assert.deepEqual(Object.keys(structured).sort(), ["assessment", "objective", "plan", "subjective"]);
});

check("the client targets Agent Platform, never AI Studio", () => {
  assert.equal(constructions.length, 1, "the client should be built once and reused");
  assert.equal(constructions[0].vertexai, true, "vertexai must be set for BAA coverage");
  assert.equal(constructions[0].project, "stub-project");
  assert.equal(getSoapAuthMode(), "application_default_credentials");
});

// ---- templates ----
for (const template of listNoteTemplates()) {
  calls.length = 0;
  const content = await generateClinicalNote("Patient transcript text.", { template: template.id });
  check(`${template.id}: returns exactly its own sections`, () => {
    assert.deepEqual(Object.keys(content).sort(), [...getTemplateSectionKeys(template.id)].sort());
  });
  check(`${template.id}: drops any key the model invents`, () => {
    assert.ok(!("injected" in content), "an unexpected model key reached storage");
  });
  check(`${template.id}: asks the model for a matching schema`, () => {
    const schema = calls.find((entry) => entry.params)?.params?.config?.responseSchema;
    assert.deepEqual(Object.keys(schema.properties).sort(), [...getTemplateSectionKeys(template.id)].sort());
    assert.deepEqual([...schema.required].sort(), [...getTemplateSectionKeys(template.id)].sort());
  });
  check(`${template.id}: sends its own prompt`, () => {
    const instruction = calls.find((entry) => entry.params)?.params?.config?.systemInstruction || "";
    assert.ok(instruction.includes("Never invent"), "the shared no-fabrication rule is missing");
    assert.ok(instruction.length > 200, "the prompt looks truncated");
  });
}

calls.length = 0;
const unknown = await generateClinicalNote("Patient transcript text.", { template: "definitely-not-real" });
check("an unknown template falls back to SOAP instead of failing", () => {
  assert.deepEqual(Object.keys(unknown).sort(), ["assessment", "objective", "plan", "subjective"]);
});

const legacy = await generateSoaps("Patient transcript text.");
check("generateSoaps keeps the four SOAP sections", () => {
  assert.deepEqual(Object.keys(legacy).sort(), ["assessment", "objective", "plan", "subjective"]);
});

// ---- visit titles ----
calls.length = 0;
nextPlainText = "Persistent migraine review";
const title = await generateVisitTitle("Patient describes migraines.");
check("a visit title comes back clean", () => {
  assert.equal(title, "Persistent migraine review");
});

nextPlainText = '  "Chris\'s ankle sprain."  ';
const messyTitle = await generateVisitTitle("x");
check("a quoted title is cleaned up", () => {
  assert.equal(messyTitle, "Chris\'s ankle sprain");
});

nextPlainText = "Untitled visit";
const emptyTitle = await generateVisitTitle("x");
check("the model's 'cannot tell' answer becomes no title, not a bad one", () => {
  assert.equal(emptyTitle, "");
});

const noTranscriptTitle = await generateVisitTitle("");
check("no transcript means no title request at all", () => {
  assert.equal(noTranscriptTitle, "");
});

const failures = results.filter(([status]) => status === "FAIL");
for (const [status, name] of results) console.log(`${status === "PASS" ? "✔" : "✖"} ${name}`);
console.log(`\n${results.length - failures.length}/${results.length} passed`);
process.exit(failures.length ? 1 : 0);
