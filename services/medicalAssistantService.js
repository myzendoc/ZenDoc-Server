import { Type } from "@google/genai";
import { getAgentPlatformClient, getSoapAuthMode } from "./soapsService.js";
import { getLanguageName } from "../utils/languages.js";
import { logError } from "../utils/logging.js";

const MODEL = "gemini-2.5-flash";
const MAX_FOLLOW_UPS = 4;
const MAX_DIAGNOSTICS = 3;
const MAX_TRANSCRIPT_CHARS = 14000;

// Each run returns the current picture rather than appending, so the panel
// stays short and the assistant can revise itself as the visit goes on.
const INSTRUCTION = `You assist a clinician during a live consultation. You are not speaking to the patient and you never make decisions.

From the conversation so far, return two things:

Follow-up questions: up to ${MAX_FOLLOW_UPS} questions the clinician has not yet asked that would most change the clinical picture. Order them by how much they would narrow the differential. Each needs a one-line reason. Skip anything already answered in the transcript.

Diagnostic suggestions: up to ${MAX_DIAGNOSTICS} conditions consistent with what has been said, each with a confidence from 0 to 100 and a one-line basis citing the specific findings that support it. Only include a condition the transcript actually supports.

Rules:
- Base everything strictly on the transcript. Never invent symptoms, history, vitals or results.
- This is the current picture, not an addition to an earlier one. Drop anything the latest conversation has ruled out or answered.
- Return an empty list rather than padding to the maximum. Early in a visit one suggestion, or none, is the honest answer.
- Confidence reflects support in this transcript alone, not population prevalence. Do not exceed 85 for a diagnosis that has not been confirmed by a test stated in the visit.
- Keep every line short enough to read at a glance mid-consultation.
- Write for a clinician: correct terminology, no hedging padding, no patient-facing phrasing.`;

const schema = {
  type: Type.OBJECT,
  properties: {
    followUps: {
      type: Type.ARRAY,
      description: "Questions the clinician has not yet asked",
      items: {
        type: Type.OBJECT,
        properties: {
          question: { type: Type.STRING, description: "The question to ask, phrased for the clinician to read aloud" },
          rationale: { type: Type.STRING, description: "One line on what it would clarify" },
        },
        required: ["question", "rationale"],
      },
    },
    diagnostics: {
      type: Type.ARRAY,
      description: "Conditions consistent with the conversation so far",
      items: {
        type: Type.OBJECT,
        properties: {
          condition: { type: Type.STRING, description: "Condition name" },
          confidence: { type: Type.NUMBER, description: "0 to 100" },
          basis: { type: Type.STRING, description: "One line citing the supporting findings" },
        },
        required: ["condition", "confidence", "basis"],
      },
    },
  },
  required: ["followUps", "diagnostics"],
};

export const ASSISTANT_DISCLAIMER =
  "These are suggestions. AI can make mistakes, check important info.";

export function isAssistantConfigured() {
  return getSoapAuthMode() !== "unconfigured";
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function languageLine(language) {
  const name = getLanguageName(language);
  return !name || name === "English" ? "" : `\n\nWrite the questions and the basis lines in ${name}. Keep condition names in standard medical English.`;
}

export async function generateAssist(transcript, { language } = {}) {
  const text = String(transcript || "").trim();
  if (!text) return null;

  try {
    const response = await getAgentPlatformClient().models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: text.slice(-MAX_TRANSCRIPT_CHARS) }] }],
      config: {
        systemInstruction: `${INSTRUCTION}${languageLine(language)}`,
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.2,
      },
    });
    const raw = response?.text?.trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);

    const followUps = (Array.isArray(parsed?.followUps) ? parsed.followUps : [])
      .filter((item) => String(item?.question || "").trim())
      .slice(0, MAX_FOLLOW_UPS)
      .map((item) => ({
        question: String(item.question).trim(),
        rationale: String(item.rationale || "").trim(),
      }));

    const diagnostics = (Array.isArray(parsed?.diagnostics) ? parsed.diagnostics : [])
      .filter((item) => String(item?.condition || "").trim())
      .slice(0, MAX_DIAGNOSTICS)
      .map((item) => ({
        condition: String(item.condition).trim(),
        confidence: clampConfidence(item.confidence),
        basis: String(item.basis || "").trim(),
      }))
      .sort((a, b) => b.confidence - a.confidence);

    if (!followUps.length && !diagnostics.length) return null;
    return { followUps, diagnostics, generatedAt: new Date().toISOString() };
  } catch (err) {
    logError("assistant.generate_failed", err);
    return null;
  }
}
