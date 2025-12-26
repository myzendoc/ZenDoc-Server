import OpenAI from "openai";

let client;

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export async function generateSoaps(transcript) {
  if (!transcript) return null;
  const openai = getClient();
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a clinical summarizer. Create a SOAP note (Subjective, Objective, Assessment, Plan) from the patient encounter and reply ONLY as valid JSON with keys: subjective, objective, assessment, plan.`,
      },
      { role: "user", content: transcript },
    ],
    max_tokens: 1500,
    response_format: { type: "json_object" },
  });
  const raw = response.choices?.[0]?.message?.content?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("SOAP parse error", err);
    return null;
  }
}
