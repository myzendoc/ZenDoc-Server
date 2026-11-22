import { normalizeLanguageCode, resolveDeepgramOptions } from "../utils/languages.js";
import { logError } from "../utils/logging.js";

const LISTEN_URL = "https://api.deepgram.com/v1/listen";
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;

export const MAX_RECORDING_BYTES = 200 * 1024 * 1024;

// Browsers record webm/ogg; uploads are usually mp3, m4a, wav or mp4.
const ACCEPTED_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/flac",
  "video/webm",
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
];

export function isAcceptedRecordingType(mimeType) {
  const type = String(mimeType || "").split(";")[0].trim().toLowerCase();
  return ACCEPTED_TYPES.includes(type);
}

export function isRecordingTranscriptionConfigured() {
  return Boolean(String(process.env.DEEPGRAM_API_KEY || "").trim());
}

// With language=multi the detected language arrives on the alternative, the
// same as in streaming; `detected_language` is not returned.
function readLanguage(channel, alternative) {
  const languages = alternative?.languages;
  if (Array.isArray(languages) && languages.length) {
    return normalizeLanguageCode(languages[0]);
  }
  return normalizeLanguageCode(channel?.detected_language);
}

// The audio is held in memory only: it goes to Deepgram and is dropped. It is
// never written to disk or to the database.
export async function transcribeRecording(buffer, { mimeType, language } = {}) {
  const key = String(process.env.DEEPGRAM_API_KEY || "").trim();
  if (!key) throw new Error("Transcription is not configured on this server");
  if (!buffer?.length) throw new Error("The recording is empty");

  const deepgram = resolveDeepgramOptions(language);
  const params = new URLSearchParams({
    model: deepgram.model,
    language: deepgram.language,
    punctuate: "true",
    smart_format: "true",
    paragraphs: "true",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${LISTEN_URL}?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${key}`,
        "Content-Type": String(mimeType || "application/octet-stream").split(";")[0],
      },
      body: buffer,
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logError("recording.transcribe_failed", new Error(`Deepgram listen returned ${response.status}: ${detail.slice(0, 200)}`));
      throw new Error(
        response.status === 400
          ? "That file could not be read as audio"
          : "Transcription failed, try again"
      );
    }

    const data = await response.json();
    const channel = data?.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    const text = String(alternative?.transcript || "").trim();

    return {
      text,
      language: readLanguage(channel, alternative) || normalizeLanguageCode(deepgram.expected) || "",
      durationSeconds: Math.round(Number(data?.metadata?.duration) || 0),
    };
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("That recording took too long to transcribe");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
