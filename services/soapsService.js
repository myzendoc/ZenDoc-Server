import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

const MODEL = "gemini-2.5-flash";
const SYSTEM_INSTRUCTION =
`
Create a detailed medical SOAP note from the following patient encounter transcript or clinical notes.



Structure the output into the four standard sections: Subjective, Objective, Assessment, and Plan.



Follow these formatting rules:



Subjective



Summarize everything reported by the patient.



Include the chief complaint, onset, duration, severity, location, quality, triggers, relieving factors, and progression of symptoms.



Capture associated symptoms and relevant negatives when mentioned.



Include past medical history, surgical history, medications, allergies, family history, and social history if present.



Add relevant lifestyle factors such as smoking, alcohol use, travel, exposure to illness, and family or living situation.



Each point should appear on a new line starting with an en dash (–) for readability.



Objective



Document measurable or observed clinical information.



Include vital signs, physical exam findings, laboratory results, imaging, and other diagnostic tests if available.



If information is not provided in the transcript, clearly note that it was not documented.



Use clear bullet points starting with an en dash (–).



Assessment



Provide a clinical interpretation of the patient’s condition.



List the primary diagnosis or presenting problem first.



Include possible differential diagnoses if the symptoms suggest multiple possibilities.



Briefly explain the clinical reasoning based on the symptoms and history.



Plan
For each problem identified, include:



Investigations that should be ordered or performed.



Medical treatments or interventions planned.



Medications, if applicable.



Referrals, monitoring, or observation plans.



Follow-up instructions or appointments.



Additional Notes



Include patient education provided during the visit.



Document patient concerns, fears, or contextual issues discussed (insurance, logistics, family concerns, etc.).



Note any reassurance or counseling provided by the clinician.



Writing style



Clear, clinical, and concise.



Each point should be on a separate line beginning with an en dash (–).



Include both clinical and relevant non-clinical conversation details if they affect care or context

The output format of each section should be in Structured/Formatted HTML instead of plain text, using appropriate tags for clarity and readability.
`

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
