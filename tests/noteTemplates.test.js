import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TEMPLATE,
  buildTemplateInstruction,
  getAllSectionKeys,
  getNoteTemplate,
  getTemplateSectionKeys,
  listNoteTemplates,
  resolveTemplateId,
} from "../utils/noteTemplates.js";
import { sanitizeSoapContent } from "../utils/clinicalHtml.js";

const EXPECTED = {
  soap: ["subjective", "objective", "assessment", "plan"],
  dap: ["data", "assessment", "plan"],
  birp: ["behavior", "intervention", "response", "plan"],
  pie: ["problem", "intervention", "evaluation"],
  girp: ["goal", "intervention", "response", "plan"],
  patient_summary: ["summary", "instructions", "warning_signs", "followup"],
  doctors_letter: ["letter"],
};

test("every template the client asked for exists", () => {
  const ids = listNoteTemplates().map((item) => item.id);
  for (const id of Object.keys(EXPECTED)) {
    assert.ok(ids.includes(id), `${id} is missing`);
  }
});

test("each template carries the sections its format is named after", () => {
  for (const [id, sections] of Object.entries(EXPECTED)) {
    assert.deepEqual(getTemplateSectionKeys(id), sections, `${id} sections differ`);
  }
});

test("SOAP is the default and leads the list", () => {
  assert.equal(DEFAULT_TEMPLATE, "soap");
  assert.equal(listNoteTemplates()[0].id, "soap");
  assert.equal(resolveTemplateId(undefined), "soap");
  assert.equal(resolveTemplateId(""), "soap");
});

test("an unknown template falls back rather than reaching the model", () => {
  assert.equal(resolveTemplateId("not-a-template"), "soap");
  assert.equal(resolveTemplateId("../../etc/passwd"), "soap");
  assert.equal(getNoteTemplate("nope"), null);
});

test("template ids are matched case-insensitively and trimmed", () => {
  assert.equal(resolveTemplateId("  BIRP "), "birp");
  assert.equal(resolveTemplateId("DAP"), "dap");
});

test("every template has a usable prompt and section metadata", () => {
  for (const template of listNoteTemplates()) {
    assert.ok(template.label, `${template.id} has no label`);
    assert.ok(template.sections.length > 0, `${template.id} has no sections`);
    for (const section of template.sections) {
      assert.ok(section.key, `${template.id} section missing key`);
      assert.ok(section.label, `${template.id} section missing label`);
      assert.ok(section.initial, `${template.id} section missing initial`);
    }
    const instruction = buildTemplateInstruction(template.id);
    assert.ok(instruction.length > 200, `${template.id} prompt looks too thin`);
    assert.ok(/Never invent/i.test(instruction), `${template.id} prompt lacks the no-fabrication rule`);
    assert.ok(/HTML/i.test(instruction), `${template.id} prompt does not ask for HTML`);
  }
});

test("section keys are unique within a template", () => {
  for (const template of listNoteTemplates()) {
    const keys = template.sections.map((section) => section.key);
    assert.equal(new Set(keys).size, keys.length, `${template.id} repeats a section key`);
  }
});

test("the sanitiser accepts every section any template can produce", () => {
  const all = getAllSectionKeys();
  for (const template of listNoteTemplates()) {
    for (const section of template.sections) {
      assert.ok(all.has(section.key), `${section.key} would be stripped on save`);
    }
  }
});

test("the sanitiser still drops keys no template defines", () => {
  const cleaned = sanitizeSoapContent({ behavior: "<p>ok</p>", password: "<p>secret</p>" });
  assert.deepEqual(Object.keys(cleaned), ["behavior"]);
});

test("the patient summary is the only patient-facing format", () => {
  const patientFacing = listNoteTemplates().filter((item) => item.patientFacing).map((item) => item.id);
  assert.deepEqual(patientFacing, ["patient_summary"]);
  assert.ok(/eighth-grade|plain language|plain words/i.test(buildTemplateInstruction("patient_summary")));
});

test("the doctor's letter refuses to invent clinician identity", () => {
  const instruction = buildTemplateInstruction("doctors_letter");
  assert.ok(instruction.includes("[Clinician name]"));
  assert.ok(instruction.includes("[Signature]"));
  assert.ok(/never invent them/i.test(instruction));
});

test("mental health formats are labelled for the right clinicians", () => {
  assert.match(getNoteTemplate("birp").audience, /mental health/i);
  assert.match(getNoteTemplate("dap").audience, /therapist|counsell/i);
});
