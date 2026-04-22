import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

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
