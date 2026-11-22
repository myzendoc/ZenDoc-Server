import { getAgentPlatformClient, getSoapAuthMode } from "./soapsService.js";
import { getLanguageName, normalizeLanguageCode } from "../utils/languages.js";
import { logError } from "../utils/logging.js";

const TRANSLATE_MODEL = "gemini-2.5-flash";
const SPEAK_URL = "https://api.deepgram.com/v2/speak";
const TTS_TIMEOUT_MS = 15000;
const MAX_SPEAK_CHARS = 1500;

// Verified against the live API: every voice below returns audio/mpeg from
// /v2/speak. Aura models are v1-only and 400 here.
const VOICES = {
  en: "flux-hannah-en",
  es: "flux-aina-es",
  fr: "flux-brigitte-fr",
  de: "flux-janine-de",
  pt: "flux-bianca-pt",
  it: "flux-angela-it",
  nl: "flux-anouk-nl",
  hi: "flux-anjali-hi",
  ja: "flux-ayumi-ja",
  ru: "flux-natalia-ru",
};

export function listSpeakableLanguages() {
  return Object.keys(VOICES);
}

export function canSpeak(language) {
  return Boolean(VOICES[normalizeLanguageCode(language)]);
}

export function isTranslationConfigured() {
  return getSoapAuthMode() !== "unconfigured";
}

export function isSpeechConfigured() {
  return Boolean(String(process.env.DEEPGRAM_API_KEY || "").trim());
}

// One utterance in, one translation out. No segmentation: a consultation turn
// is short, and splitting it would only desynchronise the audio.
export async function translateUtterance(text, { from, to }) {
  const source = String(text || "").trim();
  const target = normalizeLanguageCode(to);
  if (!source || !target) return "";
  if (normalizeLanguageCode(from) === target) return source;

  const targetName = getLanguageName(target);
  const sourceName = getLanguageName(from);
  if (!targetName) return "";

  try {
    const response = await getAgentPlatformClient().models.generateContent({
      model: TRANSLATE_MODEL,
      contents: [{ role: "user", parts: [{ text: source }] }],
      config: {
        systemInstruction: `Translate the clinical consultation speech below into ${targetName}${sourceName ? ` from ${sourceName}` : ""}.

- Reply with the translation alone. No preamble, no quotes, no notes.
- Keep the speaker's register and person. A patient's "my chest hurts" stays first person.
- Keep drug names, dosages, units and measurements exactly as given.
- Translate the meaning, not word by word. Keep it natural to say aloud.
- If the text is not intelligible speech, reply with an empty string.`,
        temperature: 0.1,
      },
    });
    return response?.text?.trim() || "";
  } catch (err) {
    logError("translation.translate_failed", err);
    return "";
  }
}

// Returns MP3 bytes, which every browser can play from a blob URL.
export async function synthesizeSpeech(text, { language }) {
  const body = String(text || "").trim().slice(0, MAX_SPEAK_CHARS);
  const voice = VOICES[normalizeLanguageCode(language)];
  const key = String(process.env.DEEPGRAM_API_KEY || "").trim();
  if (!body || !voice || !key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  try {
    const response = await fetch(`${SPEAK_URL}?model=${encodeURIComponent(voice)}&encoding=mp3`, {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: body }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logError("translation.tts_failed", new Error(`Deepgram speak returned ${response.status}`));
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    logError("translation.tts_failed", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
