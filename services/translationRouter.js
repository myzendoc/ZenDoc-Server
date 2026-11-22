import {
  canSpeak,
  isSpeechConfigured,
  isTranslationConfigured,
  synthesizeSpeech,
  translateUtterance,
} from "./translationService.js";
import { normalizeLanguageCode } from "../utils/languages.js";
import { logError } from "../utils/logging.js";

// One entry per room: who wants which language, and whether they want it spoken.
const rooms = new Map();

export function captionChannel(roomId, language) {
  return `${roomId}-xlate-${language}`;
}

function ensure(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

export function setListenerLanguage(roomId, socketId, { language, speak } = {}) {
  if (!roomId || !socketId) return null;
  const listeners = ensure(roomId);
  const code = normalizeLanguageCode(language);

  if (!code || code === "auto") {
    listeners.delete(socketId);
    if (!listeners.size) rooms.delete(roomId);
    return { language: "", speak: false };
  }

  const wantsSpeech = Boolean(speak) && canSpeak(code);
  listeners.set(socketId, { language: code, speak: wantsSpeech });
  return { language: code, speak: wantsSpeech };
}

export function removeListener(roomId, socketId) {
  const listeners = rooms.get(roomId);
  if (!listeners) return;
  listeners.delete(socketId);
  if (!listeners.size) rooms.delete(roomId);
}

export function clearRoomTranslation(roomId) {
  rooms.delete(roomId);
}

export function getListenerLanguage(roomId, socketId) {
  return rooms.get(roomId)?.get(socketId) || null;
}

// The set of languages actually being listened to, and whether any listener in
// each wants audio. Nothing is translated or synthesised for anything else.
export function activeTargets(roomId, sourceLanguage) {
  const listeners = rooms.get(roomId);
  if (!listeners?.size) return [];
  const source = normalizeLanguageCode(sourceLanguage);
  const targets = new Map();
  for (const { language, speak } of listeners.values()) {
    if (!language || language === source) continue;
    const existing = targets.get(language);
    if (existing) existing.speak = existing.speak || speak;
    else targets.set(language, { language, speak });
  }
  return [...targets.values()];
}

export function hasListeners(roomId) {
  return Boolean(rooms.get(roomId)?.size);
}

// Translates one finished utterance into every language someone is listening
// in, then speaks it for those who asked for audio.
export async function fanoutUtterance({ roomId, text, sourceLanguage, speakerPeerId, emit }) {
  const utterance = String(text || "").trim();
  if (!utterance || !isTranslationConfigured()) return 0;

  const targets = activeTargets(roomId, sourceLanguage);
  if (!targets.length) return 0;

  const results = await Promise.all(
    targets.map(async ({ language, speak }) => {
      try {
        const translated = await translateUtterance(utterance, { from: sourceLanguage, to: language });
        if (!translated) return 0;

        emit(captionChannel(roomId, language), "translation:caption", {
          language,
          sourceLanguage: normalizeLanguageCode(sourceLanguage) || "",
          speakerPeerId,
          text: translated,
          timestamp: new Date().toISOString(),
        });

        if (speak && isSpeechConfigured()) {
          const audio = await synthesizeSpeech(translated, { language });
          if (audio) {
            emit(captionChannel(roomId, language), "translation:audio", {
              language,
              speakerPeerId,
              audio,
              mimeType: "audio/mpeg",
            });
          }
        }
        return 1;
      } catch (err) {
        logError("translation.fanout_failed", err);
        return 0;
      }
    })
  );

  return results.reduce((total, value) => total + value, 0);
}

export function __resetTranslationState() {
  rooms.clear();
}
