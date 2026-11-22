// Clinical note formats. Adding one here is enough: the API, the generator and
// the section allow-list all read from this file.

const SHARED_RULES = `
Follow these rules for every section:
- Every point on its own line. Never combine unrelated ideas into one line.
- No paragraph blocks. Be clinically precise and specific.
- Include only what the transcript states or clearly implies. Never invent findings, values or history.
- Convert conversational statements into professional clinical documentation.
- Output each section as structured HTML using <p>, <ul>, <li> and <strong>, not plain text.
- Omit a sub-item entirely when the transcript does not cover it, rather than writing "not discussed".
`.trim();

export const DEFAULT_TEMPLATE = "soap";

const TEMPLATES = [
  {
    id: "soap",
    label: "SOAP note",
    description: "General clinical visit documentation",
    audience: "All clinicians",
    sections: [
      { key: "subjective", label: "Subjective", initial: "S" },
      { key: "objective", label: "Objective", initial: "O" },
      { key: "assessment", label: "Assessment", initial: "A" },
      { key: "plan", label: "Plan", initial: "P" },
    ],
    instruction: `Create a comprehensive medical SOAP note from the transcript.

Subjective: the patient's reported history, symptoms, onset, duration, severity, pertinent negatives, medications, prior testing, family history and social factors.
Objective: examination findings, vital signs, measurements and results stated in the visit.
Assessment: organise by numbered problems. Each problem begins with a number and a clear diagnostic title, then clinical interpretation, relevant differentials, risk stratification and epidemiologic context where discussed.
Plan: mirror the same numbered problems with exactly matching numbers. Under each, give the diagnostic plan, treatment plan, medication decisions, counselling provided, follow-up timeline and contingency plans. Document shared decision-making where it occurred.`,
  },
  {
    id: "dap",
    label: "DAP note",
    description: "Data, Assessment, Plan",
    audience: "Therapists and counsellors",
    sections: [
      { key: "data", label: "Data", initial: "D" },
      { key: "assessment", label: "Assessment", initial: "A" },
      { key: "plan", label: "Plan", initial: "P" },
    ],
    instruction: `Create a DAP progress note from the transcript.

Data: objective and subjective observations from the session together — what the client reported, what was observed about affect, presentation and engagement, and the content covered. Keep this descriptive, not interpretive.
Assessment: the clinician's interpretation — progress toward goals, clinical impressions, risk assessment where discussed, and how the client is responding to treatment.
Plan: next steps, interventions planned, homework or between-session tasks, referrals, and the date or interval for the next session.`,
  },
  {
    id: "birp",
    label: "BIRP note",
    description: "Behavior, Intervention, Response, Plan",
    audience: "Mental health clinicians",
    sections: [
      { key: "behavior", label: "Behavior", initial: "B" },
      { key: "intervention", label: "Intervention", initial: "I" },
      { key: "response", label: "Response", initial: "R" },
      { key: "plan", label: "Plan", initial: "P" },
    ],
    instruction: `Create a BIRP progress note from the transcript.

Behavior: the client's presenting problem, reported symptoms and observable behaviour this session, including mood, affect and anything quoted directly.
Intervention: what the clinician actually did — the therapeutic approach, techniques and topics worked through. Write in the past tense, describing the clinician's actions.
Response: how the client responded to each intervention, including engagement, insight shown, resistance and any shift during the session.
Plan: next session's focus, assigned tasks, changes to the treatment plan, referrals and follow-up interval.`,
  },
  {
    id: "pie",
    label: "PIE note",
    description: "Problem, Intervention, Evaluation",
    audience: "Nursing and allied health",
    sections: [
      { key: "problem", label: "Problem", initial: "P" },
      { key: "intervention", label: "Intervention", initial: "I" },
      { key: "evaluation", label: "Evaluation", initial: "E" },
    ],
    instruction: `Create a PIE note from the transcript.

Problem: the identified problem or nursing diagnosis, with the supporting subjective and objective data stated in the visit.
Intervention: the specific actions taken or ordered to address that problem.
Evaluation: the outcome of those interventions, the patient's response, and whether the problem is resolved, improving or unchanged.`,
  },
  {
    id: "girp",
    label: "GIRP note",
    description: "Goal, Intervention, Response, Plan",
    audience: "Goal-directed therapy",
    sections: [
      { key: "goal", label: "Goal", initial: "G" },
      { key: "intervention", label: "Intervention", initial: "I" },
      { key: "response", label: "Response", initial: "R" },
      { key: "plan", label: "Plan", initial: "P" },
    ],
    instruction: `Create a GIRP progress note from the transcript.

Goal: the treatment goal or objective this session worked toward, stated as it was framed in the session.
Intervention: the clinician's actions and techniques directed at that goal.
Response: the client's response, measurable progress toward the goal, and any barriers raised.
Plan: next steps toward the goal, revisions to it, assigned work and follow-up interval.`,
  },
  {
    id: "patient_summary",
    label: "Patient post-visit summary",
    description: "Plain-language recap to send to the patient",
    audience: "Written for the patient",
    patientFacing: true,
    sections: [
      { key: "summary", label: "What we discussed", initial: "1" },
      { key: "instructions", label: "What to do next", initial: "2" },
      { key: "warning_signs", label: "When to seek help", initial: "3" },
      { key: "followup", label: "Follow-up", initial: "4" },
    ],
    instruction: `Write a post-visit summary addressed directly to the patient, from the transcript.

Write at roughly an eighth-grade reading level. Use "you" and "your". Replace clinical terms with plain words, keeping the clinical term in brackets only where the patient will see it on a label or prescription. Warm and clear, never alarming. Never add advice that was not given in the visit.

What we discussed: why they came in and what was found, in plain language.
What to do next: medications with how and when to take them, tests to book, and lifestyle steps, as a short numbered list of actions.
When to seek help: the specific symptoms that mean they should call the clinic or seek urgent care, only where discussed in the visit.
Follow-up: when to come back and how to book.`,
  },
  {
    id: "doctors_letter",
    label: "Doctor's letter",
    description: "Formal letter or medical certificate",
    audience: "For employers, schools and third parties",
    sections: [
      { key: "letter", label: "Letter", initial: "L" },
    ],
    instruction: `Write a formal doctor's letter documenting this visit, from the transcript.

Produce one continuous letter, not sections. Structure it as: a "To whom it may concern" opening, confirmation that the patient was seen and the date of the visit, the clinically relevant findings, any recommended restrictions or time away from work or study with specific dates where stated, and a closing offering to provide further information.

Disclose only what is necessary for the letter's purpose; omit sensitive history that a third party does not need. Leave the clinician's name, registration number and signature as the placeholders [Clinician name], [Registration number] and [Signature] — never invent them. If the transcript does not state the duration of any recommended absence, write [duration to be confirmed] rather than guessing.`,
  },
];

const BY_ID = new Map(TEMPLATES.map((template) => [template.id, template]));

export function listNoteTemplates() {
  return TEMPLATES.map(({ id, label, description, audience, sections, patientFacing }) => ({
    id,
    label,
    description,
    audience,
    patientFacing: Boolean(patientFacing),
    sections: sections.map(({ key, label: sectionLabel, initial }) => ({ key, label: sectionLabel, initial })),
  }));
}

export function getNoteTemplate(id) {
  return BY_ID.get(String(id || "").trim().toLowerCase()) || null;
}

export function resolveTemplateId(id) {
  return BY_ID.has(String(id || "").trim().toLowerCase())
    ? String(id).trim().toLowerCase()
    : DEFAULT_TEMPLATE;
}

export function getTemplateSectionKeys(id) {
  const template = getNoteTemplate(id) || BY_ID.get(DEFAULT_TEMPLATE);
  return template.sections.map((section) => section.key);
}

// Every key any template can produce, so stored content survives sanitising.
export function getAllSectionKeys() {
  const keys = new Set(["note"]);
  for (const template of TEMPLATES) {
    for (const section of template.sections) keys.add(section.key);
  }
  return keys;
}

export function buildTemplateInstruction(id) {
  const template = getNoteTemplate(id) || BY_ID.get(DEFAULT_TEMPLATE);
  return `${template.instruction}\n\n${SHARED_RULES}`;
}
