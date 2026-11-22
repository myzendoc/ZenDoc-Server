// Checks live translation routing: per-language channels, no work for
// languages nobody selected, and audio only for listeners who asked for it.
// Gemini and Deepgram are stubbed.
// Run: node --experimental-test-module-mocks scripts/translationCheck.mjs
import { mock } from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_CLOUD_PROJECT = "stub-project";
process.env.DEEPGRAM_API_KEY = "stub-key";

let translateCalls = [];
let ttsCalls = [];

mock.module("@google/genai", {
  namedExports: {
    Type: { OBJECT: "OBJECT", STRING: "STRING", ARRAY: "ARRAY", NUMBER: "NUMBER" },
    GoogleGenAI: class {
      constructor() {
        this.models = {
          generateContent: async (params) => {
            const instruction = params?.config?.systemInstruction || "";
            const text = params?.contents?.[0]?.parts?.[0]?.text || "";
            const target = instruction.match(/into ([A-Za-z]+)/)?.[1] || "?";
            translateCalls.push({ target, text });
            return { text: `[${target}] ${text}` };
          },
        };
      }
    },
  },
});

// Stand in for Deepgram's /v2/speak so no audio is actually bought.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.includes("api.deepgram.com")) {
    const model = new URL(href).searchParams.get("model");
    ttsCalls.push({ model, body: JSON.parse(init.body).text });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(`audio:${model}`).buffer,
    };
  }
  return realFetch(url, init);
};

const router = await import("../services/translationRouter.js");
const { canSpeak, listSpeakableLanguages } = await import("../services/translationService.js");
const { MEDICAL_LANGUAGES } = await import("../utils/languages.js");

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(["PASS", name]);
  } catch (err) {
    results.push(["FAIL", `${name} :: ${err.message}`]);
  }
};

const emitted = [];
const emit = (channel, event, payload) => emitted.push({ channel, event, payload });
const reset = () => {
  emitted.length = 0;
  translateCalls = [];
  ttsCalls = [];
  router.__resetTranslationState();
};

check("every language a visit can be transcribed in can also be spoken", () => {
  for (const code of MEDICAL_LANGUAGES) {
    assert.ok(canSpeak(code), `${code} has no TTS voice`);
  }
  assert.equal(listSpeakableLanguages().length >= MEDICAL_LANGUAGES.length, true);
});

// ---- nobody listening ----
reset();
let count = await router.fanoutUtterance({
  roomId: "r1",
  text: "Me duele la cabeza.",
  sourceLanguage: "es",
  speakerPeerId: "p1",
  emit,
});
check("COST: no listeners means no translation and no TTS", () => {
  assert.equal(count, 0);
  assert.equal(translateCalls.length, 0, "the model was called with nobody listening");
  assert.equal(ttsCalls.length, 0);
  assert.equal(emitted.length, 0);
});

// ---- one listener, captions only ----
reset();
router.setListenerLanguage("r1", "socket-a", { language: "en", speak: false });
count = await router.fanoutUtterance({
  roomId: "r1",
  text: "Me duele la cabeza.",
  sourceLanguage: "es",
  speakerPeerId: "p1",
  emit,
});
check("a caption-only listener gets text and no audio", () => {
  assert.equal(count, 1);
  assert.equal(translateCalls.length, 1);
  assert.equal(ttsCalls.length, 0, "TTS ran for a listener who did not ask for it");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, "translation:caption");
  assert.equal(emitted[0].channel, "r1-xlate-en");
  assert.equal(emitted[0].payload.text, "[English] Me duele la cabeza.");
});

// ---- same listener, now with voice ----
reset();
router.setListenerLanguage("r1", "socket-a", { language: "en", speak: true });
await router.fanoutUtterance({ roomId: "r1", text: "Hola.", sourceLanguage: "es", speakerPeerId: "p1", emit });
check("turning voice on adds audio on the same channel", () => {
  const events = emitted.map((item) => item.event);
  assert.deepEqual(events, ["translation:caption", "translation:audio"]);
  assert.equal(emitted[1].channel, "r1-xlate-en");
  assert.equal(emitted[1].payload.mimeType, "audio/mpeg");
  assert.ok(Buffer.isBuffer(emitted[1].payload.audio), "audio should be bytes");
});

check("TTS used the voice for the listener's language", () => {
  assert.equal(ttsCalls.length, 1);
  assert.ok(ttsCalls[0].model.endsWith("-en"), `unexpected voice ${ttsCalls[0].model}`);
  assert.equal(ttsCalls[0].body, "[English] Hola.");
});

// ---- two listeners, different languages ----
reset();
router.setListenerLanguage("r2", "socket-a", { language: "en", speak: true });
router.setListenerLanguage("r2", "socket-b", { language: "fr", speak: false });
await router.fanoutUtterance({ roomId: "r2", text: "Hola.", sourceLanguage: "es", speakerPeerId: "p1", emit });

check("each language is translated once, on its own channel", () => {
  assert.equal(translateCalls.length, 2);
  const channels = new Set(emitted.map((item) => item.channel));
  assert.deepEqual([...channels].sort(), ["r2-xlate-en", "r2-xlate-fr"]);
});

check("audio goes only to the channel that asked for it", () => {
  const audio = emitted.filter((item) => item.event === "translation:audio");
  assert.equal(audio.length, 1);
  assert.equal(audio[0].channel, "r2-xlate-en");
});

// ---- two listeners sharing a language ----
reset();
router.setListenerLanguage("r3", "socket-a", { language: "en", speak: false });
router.setListenerLanguage("r3", "socket-b", { language: "en", speak: true });
await router.fanoutUtterance({ roomId: "r3", text: "Hola.", sourceLanguage: "es", speakerPeerId: "p1", emit });
check("COST: a shared language is translated once, not once per listener", () => {
  assert.equal(translateCalls.length, 1);
  assert.equal(ttsCalls.length, 1, "TTS should also run once for the shared channel");
});

// ---- listener in the speaker's own language ----
reset();
router.setListenerLanguage("r4", "socket-a", { language: "es", speak: true });
count = await router.fanoutUtterance({ roomId: "r4", text: "Hola.", sourceLanguage: "es", speakerPeerId: "p1", emit });
check("COST: nothing is translated into the language already being spoken", () => {
  assert.equal(count, 0);
  assert.equal(translateCalls.length, 0);
  assert.equal(emitted.length, 0);
});

// ---- switching back to the original audio ----
reset();
router.setListenerLanguage("r5", "socket-a", { language: "en", speak: true });
const cleared = router.setListenerLanguage("r5", "socket-a", { language: "", speak: false });
await router.fanoutUtterance({ roomId: "r5", text: "Hola.", sourceLanguage: "es", speakerPeerId: "p1", emit });
check("choosing the original audio stops all work for that listener", () => {
  assert.equal(cleared.language, "");
  assert.equal(translateCalls.length, 0);
  assert.equal(router.hasListeners("r5"), false);
});

// ---- disconnect ----
reset();
router.setListenerLanguage("r6", "socket-a", { language: "fr", speak: false });
router.removeListener("r6", "socket-a");
await router.fanoutUtterance({ roomId: "r6", text: "Hola.", sourceLanguage: "es", speakerPeerId: "p1", emit });
check("a disconnected listener stops costing anything", () => {
  assert.equal(translateCalls.length, 0);
  assert.equal(router.hasListeners("r6"), false);
});

// ---- language with no voice ----
reset();
const noVoice = router.setListenerLanguage("r7", "socket-a", { language: "th", speak: true });
await router.fanoutUtterance({ roomId: "r7", text: "Hola.", sourceLanguage: "es", speakerPeerId: "p1", emit });
check("a language with no TTS voice still gets captions, silently", () => {
  assert.equal(noVoice.language, "th");
  assert.equal(noVoice.speak, false, "speak should be refused when no voice exists");
  assert.equal(emitted.filter((item) => item.event === "translation:audio").length, 0);
  assert.equal(emitted.filter((item) => item.event === "translation:caption").length, 1);
});

// ---- unknown language ----
reset();
const bogus = router.setListenerLanguage("r8", "socket-a", { language: "klingon", speak: true });
check("an unsupported language is refused rather than passed on", () => {
  assert.equal(bogus.language, "");
  assert.equal(router.hasListeners("r8"), false);
});

// ---- room teardown ----
reset();
router.setListenerLanguage("r9", "socket-a", { language: "en", speak: false });
router.clearRoomTranslation("r9");
check("ending the room clears its listeners", () => {
  assert.equal(router.hasListeners("r9"), false);
});

const failures = results.filter(([status]) => status === "FAIL");
for (const [status, name] of results) console.log(`${status === "PASS" ? "✔" : "✖"} ${name}`);
console.log(`\n${results.length - failures.length}/${results.length} passed`);
process.exit(failures.length ? 1 : 0);
