import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

const MODEL = "gemini-2.5-flash";
const SYSTEM_INSTRUCTION =
`You are a clinician drafting a structured medical visit note based on raw patient information.
Write in clear, professional clinical language suitable for an outpatient progress note.
Do not invent findings. Infer clinically when reasonable and clearly connect symptoms, labs, and history.

Format the output exactly using the following sections and style:

Subjective

Summarize the reason for visit and timeline of symptoms in full sentences.

Include relevant symptoms, patient-reported behaviors, and context (school, work, lifestyle).

Include past medical history, family history, medications, allergies, and social history if provided.

Write as a concise but thorough narrative, not bullet fragments.

Objective

Include relevant physical exam findings.

List investigations and lab results with brief clinical interpretation where appropriate.

Use bullet points for clarity.

Assessment & Plan

Number each problem separately.

For each problem:

Assessment: Explain clinical reasoning. Connect labs, symptoms, and history. Address differential considerations and why certain causes are more or less likely.

Plan: Include investigations, referrals, counseling, and follow-up.

Additional Notes

Patient education provided, written in plain but accurate medical language.

Clarify misconceptions the patient had and how they were addressed.

Include any reassurance, anticipatory guidance, or unanswered concerns discussed.

Tone and constraints:

Professional, neutral, and precise.

No filler language.

No generic templates.

Explain mechanisms briefly when clinically relevant (e.g., lab artifacts, physiology).

Assume the reader is another clinician.`

let model;

const soapSchema = {
  description: "SOAP note structure",
  type: SchemaType.OBJECT,
  properties: {
    subjective: { type: SchemaType.STRING, description: "Patient's subjective report" },
    objective: { type: SchemaType.STRING, description: "Physician's objective findings" },
    assessment: { type: SchemaType.STRING, description: "Diagnosis or analysis" },
    plan: { type: SchemaType.STRING, description: "Treatment plan" },
  },
  required: ["subjective", "objective", "assessment", "plan"],
};

function getModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set");
  }
  if (!model) {
    const genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({ model: MODEL });
  }
  return model;
}

export async function generateSoaps(transcript) {
  if (!transcript) return null;

  const generativeModel = getModel();

  try {
      const result = await generativeModel.generateContent({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: transcript }] }],
        generationConfig: {
        responseMimeType: "application/json", 
        responseSchema: soapSchema,
      },
      });
      const raw = result.response?.text()?.trim();
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.error("Gemini SOAP generation error", err);
      return null
    }
}
