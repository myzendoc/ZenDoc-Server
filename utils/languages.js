// Deepgram model/language matrix: nova-3-medical takes `multi` or English codes
// only, nova-3 takes the wider monolingual set. See docs/TRANSCRIPTION.md.
const MEDICAL_MULTI = ["en", "es", "fr", "de", "hi", "it", "ja", "nl", "pt", "ru"];

export const AUTO_LANGUAGE = "auto";
export const DEFAULT_LANGUAGE = AUTO_LANGUAGE;

const CATALOGUE = [
  { code: "auto", label: "Auto-detect", englishLabel: "Auto-detect", medical: true },
  { code: "en", label: "English", englishLabel: "English", medical: true },
  { code: "es", label: "Español", englishLabel: "Spanish", medical: true },
  { code: "fr", label: "Français", englishLabel: "French", medical: true },
  { code: "de", label: "Deutsch", englishLabel: "German", medical: true },
  { code: "pt", label: "Português", englishLabel: "Portuguese", medical: true },
  { code: "it", label: "Italiano", englishLabel: "Italian", medical: true },
  { code: "nl", label: "Nederlands", englishLabel: "Dutch", medical: true },
  { code: "hi", label: "हिन्दी", englishLabel: "Hindi", medical: true },
  { code: "ja", label: "日本語", englishLabel: "Japanese", medical: true },
  { code: "ru", label: "Русский", englishLabel: "Russian", medical: true },
  { code: "zh", label: "中文", englishLabel: "Chinese", medical: false },
  { code: "ar", label: "العربية", englishLabel: "Arabic", medical: false },
  { code: "ko", label: "한국어", englishLabel: "Korean", medical: false },
  { code: "pl", label: "Polski", englishLabel: "Polish", medical: false },
  { code: "tr", label: "Türkçe", englishLabel: "Turkish", medical: false },
  { code: "sv", label: "Svenska", englishLabel: "Swedish", medical: false },
  { code: "da", label: "Dansk", englishLabel: "Danish", medical: false },
  { code: "no", label: "Norsk", englishLabel: "Norwegian", medical: false },
  { code: "fi", label: "Suomi", englishLabel: "Finnish", medical: false },
  { code: "el", label: "Ελληνικά", englishLabel: "Greek", medical: false },
  { code: "he", label: "עברית", englishLabel: "Hebrew", medical: false },
  { code: "id", label: "Bahasa Indonesia", englishLabel: "Indonesian", medical: false },
  { code: "ms", label: "Bahasa Melayu", englishLabel: "Malay", medical: false },
  { code: "ro", label: "Română", englishLabel: "Romanian", medical: false },
  { code: "cs", label: "Čeština", englishLabel: "Czech", medical: false },
  { code: "uk", label: "Українська", englishLabel: "Ukrainian", medical: false },
  { code: "vi", label: "Tiếng Việt", englishLabel: "Vietnamese", medical: false },
  { code: "th", label: "ไทย", englishLabel: "Thai", medical: false },
  { code: "ta", label: "தமிழ்", englishLabel: "Tamil", medical: false },
  { code: "ur", label: "اردو", englishLabel: "Urdu", medical: false },
  { code: "tl", label: "Tagalog", englishLabel: "Tagalog", medical: false },
];

const BY_CODE = new Map(CATALOGUE.map((item) => [item.code, item]));

export function listSupportedLanguages() {
  return CATALOGUE.map(({ code, label, englishLabel, medical }) => ({ code, label, englishLabel, medical }));
}

// Strips region subtags ("es-419" -> "es") so stored and selected codes compare equal.
export function normalizeLanguageCode(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return "";
  if (raw === "multi" || raw === "automatic" || raw === "detect") return AUTO_LANGUAGE;
  if (BY_CODE.has(raw)) return raw;
  const base = raw.split("-")[0];
  return BY_CODE.has(base) ? base : "";
}

export function isSupportedLanguage(value) {
  return Boolean(normalizeLanguageCode(value));
}

export function resolveLanguage(value) {
  return normalizeLanguageCode(value) || DEFAULT_LANGUAGE;
}

export function getLanguageName(value) {
  const code = normalizeLanguageCode(value);
  return BY_CODE.get(code)?.englishLabel || "";
}

// Picks the Deepgram model and language parameter for a selected code.
export function resolveDeepgramOptions(value) {
  const code = resolveLanguage(value);
  if (code === AUTO_LANGUAGE) return { model: "nova-3-medical", language: "multi", expected: "" };
  if (code === "en") return { model: "nova-3-medical", language: "en", expected: "en" };
  // The other medical languages are only reachable through `multi`, which keeps
  // the clinical vocabulary; the expected code still drives note generation.
  if (MEDICAL_MULTI.includes(code)) return { model: "nova-3-medical", language: "multi", expected: code };
  return { model: "nova-3", language: code, expected: code };
}

// The language the SOAP note should be written in, given what was transcribed.
export function resolveNoteLanguage({ selected, detected } = {}) {
  const chosen = normalizeLanguageCode(selected);
  if (chosen && chosen !== AUTO_LANGUAGE) return chosen;
  return normalizeLanguageCode(detected) || "en";
}

export const MEDICAL_LANGUAGES = [...MEDICAL_MULTI];
