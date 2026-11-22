import { GoogleGenAI, Type } from "@google/genai";
import { getLanguageName } from "../utils/languages.js";
import { buildTemplateInstruction, getNoteTemplate, resolveTemplateId } from "../utils/noteTemplates.js";
import { logError } from "../utils/logging.js";

const MODEL = "gemini-2.5-flash";
function buildSchema(template) {
  return {
    description: `${template.label} structure`,
    type: Type.OBJECT,
    properties: Object.fromEntries(
      template.sections.map((section) => [section.key, { type: Type.STRING, description: section.label }])
    ),
    required: template.sections.map((section) => section.key),
  };
}

let client;

// Both paths target aiplatform.googleapis.com (Agent Platform, formerly Vertex
// AI), which is HIPAA-eligible under the Google Cloud BAA. There is no path to
// the AI Studio endpoint, which is not covered.
export function getAgentPlatformClient() {
  if (client) return client;

  const apiKey = String(process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  const location = String(process.env.GOOGLE_CLOUD_LOCATION || "").trim() || "us-central1";

  if (apiKey) {
    client = new GoogleGenAI({ vertexai: true, apiKey, ...(project ? { project, location } : {}) });
  } else if (project) {
    client = new GoogleGenAI({ vertexai: true, project, location });
  } else {
    throw new Error(
      "Set GOOGLE_API_KEY or GOOGLE_CLOUD_PROJECT; SOAP generation requires Agent Platform (see docs/HIPAA.md)"
    );
  }
  return client;
}

export function getSoapAuthMode() {
  if (String(process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY || "").trim()) return "api_key";
  if (String(process.env.GOOGLE_CLOUD_PROJECT || "").trim()) return "application_default_credentials";
  return "unconfigured";
}

export function isSoapGenerationConfigured() {
  return getSoapAuthMode() !== "unconfigured";
}

// The note is written in the language of the consultation, with clinical
// section names and codes left in their standard form.
function languageInstruction(language) {
  const name = getLanguageName(language);
  if (!name || name === "English") return "";
  return `\n\nWrite every section of the note in ${name}, the language of the consultation. Keep drug names, dosages, lab names and ICD/CPT codes in their internationally recognised form. Do not translate the transcript into English first.`;
}

export async function generateClinicalNote(transcript, { language, template } = {}) {
  if (!transcript) return null;

  const templateId = resolveTemplateId(template);
  const definition = getNoteTemplate(templateId);

  try {
    const response = await getAgentPlatformClient().models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: transcript }] }],
      config: {
        systemInstruction: `${buildTemplateInstruction(templateId)}${languageInstruction(language)}`,
        responseMimeType: "application/json",
        responseSchema: buildSchema(definition),
      },
    });
    const raw = response?.text?.trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Keep only this template's sections so a stray key cannot reach storage.
    return Object.fromEntries(
      definition.sections
        .map((section) => [section.key, parsed?.[section.key]])
        .filter(([, value]) => typeof value === "string" && value.trim())
    );
  } catch (err) {
    logError("soap.generation_failed", err);
    return null;
  }
}

export function generateSoaps(transcript, options = {}) {
  return generateClinicalNote(transcript, options);
}

const TITLE_INSTRUCTION = `Write a short title for this clinical visit, the way a chat app titles a conversation.

Rules:
- Three to six words. No trailing punctuation.
- Name the main clinical issue, not the format. "Persistent migraine review", not "Patient visit note".
- Use the patient's name only if the transcript states it, as a first name and possessive: "Chris's ankle sprain".
- Plain clinical language the provider will recognise at a glance in a list.
- If the transcript is too short or unclear to tell, answer exactly: Untitled visit
- Reply with the title alone, nothing else.`;

export async function generateVisitTitle(transcript, { language } = {}) {
  if (!transcript) return "";
  try {
    const response = await getAgentPlatformClient().models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: transcript.slice(0, 12000) }] }],
      config: {
        systemInstruction: `${TITLE_INSTRUCTION}${languageInstruction(language)}`,
        temperature: 0.2,
        maxOutputTokens: 500,
      },
    });
    const title = response?.text?.trim().replace(/^["'\s]+|["'\s.]+$/g, "").slice(0, 80);
    return !title || title.toLowerCase() === "untitled visit" ? "" : title;
  } catch (err) {
    logError("soap.title_failed", err);
    return "";
  }
}
