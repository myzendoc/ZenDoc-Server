import { getAgentPlatformClient, getSoapAuthMode } from "./soapsService.js";
import { normalizeVector } from "../utils/vector.js";
import { logError } from "../utils/logging.js";

// Same Agent Platform client as SOAP generation, so embeddings stay inside the
// Google Cloud BAA. There is no path to the uncovered AI Studio endpoint.
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMS = 768;
const MAX_BATCH = 16;
const MAX_CHARS = 8000;

export function isEmbeddingConfigured() {
  return getSoapAuthMode() !== "unconfigured";
}

function truncate(text) {
  return String(text || "").slice(0, MAX_CHARS);
}

async function embedBatch(texts, taskType) {
  const response = await getAgentPlatformClient().models.embedContent({
    model: EMBEDDING_MODEL,
    contents: texts.map((text) => ({ role: "user", parts: [{ text: truncate(text) }] })),
    config: { taskType, outputDimensionality: EMBEDDING_DIMS, autoTruncate: true },
  });
  const embeddings = response?.embeddings || [];
  if (embeddings.length !== texts.length) {
    throw new Error(`Expected ${texts.length} embeddings, received ${embeddings.length}`);
  }
  // Shortened gemini-embedding-001 vectors are not unit length, so normalise here.
  return embeddings.map((item) => normalizeVector(item?.values || []));
}

export async function embedDocuments(texts = []) {
  const usable = texts.filter((text) => String(text || "").trim());
  if (!usable.length) return [];
  const results = [];
  for (let i = 0; i < usable.length; i += MAX_BATCH) {
    const batch = usable.slice(i, i + MAX_BATCH);
    results.push(...(await embedBatch(batch, "RETRIEVAL_DOCUMENT")));
  }
  return results;
}

export async function embedQuery(text) {
  if (!String(text || "").trim()) return null;
  try {
    const [vector] = await embedBatch([text], "RETRIEVAL_QUERY");
    return vector || null;
  } catch (err) {
    logError("embedding.query_failed", err);
    return null;
  }
}
