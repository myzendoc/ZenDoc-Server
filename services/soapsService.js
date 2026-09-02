import { GoogleGenAI, Type } from "@google/genai";
import { logError } from "../utils/logging.js";

const MODEL = "gemini-2.5-flash";
const SYSTEM_INSTRUCTION =
`
Create a comprehensive medical SOAP note based on the transcript.



Follow these strict formatting rules:



Use four main sections: Subjective, Objective, Assessment, and Plan.



Under each section, every point must be on a new line.



Do not combine unrelated ideas into a single bullet.



Do not use paragraph blocks.



Be detailed, clinically precise, and specific.



Include all relevant details from the transcript, including medications, prior testing, family history, social factors, and pertinent negatives.



Convert conversational statements into professional medical documentation.



Do not add information that is not stated or clearly implied.



For the Assessment section:



Organize by numbered problems.



Each problem must begin with a number and a clear diagnostic title.



Under each problem, include:



Clinical interpretation of findings



Relevant differential considerations if appropriate



Risk stratification if discussed



Epidemiologic context if mentioned



For the Plan section:



Mirror the same numbered problems listed in the Assessment.



Each problem number must match exactly.



Under each problem, include if available, if not do not mention at all:



Diagnostic plan



Treatment plan



Medication decisions



Counseling provided



Follow-up timeline



Contingency plans based on possible results



Each item must be on its own hyphenated line.



Include shared decision-making documentation where applicable.

The output format of each section should be in Structured/Formatted HTML instead of plain text, using appropriate tags for clarity and readability.
`

const soapSchema = {
  description: "SOAP note structure",
  type: Type.OBJECT,
  properties: {
    subjective: { type: Type.STRING, description: "Patient's subjective report" },
    objective: { type: Type.STRING, description: "Physician's objective findings" },
    assessment: { type: Type.STRING, description: "Diagnosis or analysis" },
    plan: { type: Type.STRING, description: "Treatment plan" },
  },
  required: ["subjective", "objective", "assessment", "plan"],
};

let client;

// Both paths target aiplatform.googleapis.com (Agent Platform, formerly Vertex
// AI), which is HIPAA-eligible under the Google Cloud BAA. There is no path to
// the AI Studio endpoint, which is not covered.
function getClient() {
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

export async function generateSoaps(transcript) {
  if (!transcript) return null;

  try {
    const response = await getClient().models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: transcript }] }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: soapSchema,
      },
    });
    const raw = response?.text?.trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    logError("soap.generation_failed", err);
    return null;
  }
}
