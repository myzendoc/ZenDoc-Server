import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_LANGUAGE,
  getLanguageName,
  isSupportedLanguage,
  listSupportedLanguages,
  MEDICAL_LANGUAGES,
  normalizeLanguageCode,
  resolveDeepgramOptions,
  resolveLanguage,
  resolveNoteLanguage,
} from "../utils/languages.js";

test("region subtags collapse to the base language", () => {
  assert.equal(normalizeLanguageCode("es-419"), "es");
  assert.equal(normalizeLanguageCode("pt-BR"), "pt");
  assert.equal(normalizeLanguageCode("en_US"), "en");
  assert.equal(normalizeLanguageCode("FR"), "fr");
});

test("Deepgram's multi code maps onto our auto option", () => {
  assert.equal(normalizeLanguageCode("multi"), AUTO_LANGUAGE);
  assert.equal(normalizeLanguageCode("detect"), AUTO_LANGUAGE);
});

test("unknown languages are rejected rather than passed to Deepgram", () => {
  assert.equal(normalizeLanguageCode("klingon"), "");
  assert.equal(normalizeLanguageCode(""), "");
  assert.equal(normalizeLanguageCode(null), "");
  assert.equal(isSupportedLanguage("xx-YY"), false);
  // An unsupported code must not silently become a different language.
  assert.equal(resolveLanguage("klingon"), AUTO_LANGUAGE);
});

test("auto-detect uses the medical multilingual model", () => {
  const options = resolveDeepgramOptions("auto");
  assert.equal(options.model, "nova-3-medical");
  assert.equal(options.language, "multi");
  assert.equal(options.expected, "");
});

test("English locks to the medical model on a single language", () => {
  assert.deepEqual(resolveDeepgramOptions("en"), {
    model: "nova-3-medical",
    language: "en",
    expected: "en",
  });
});

test("the other medical languages reach nova-3-medical through multi", () => {
  for (const code of MEDICAL_LANGUAGES.filter((item) => item !== "en")) {
    const options = resolveDeepgramOptions(code);
    assert.equal(options.model, "nova-3-medical", `${code} should stay on the medical model`);
    assert.equal(options.language, "multi", `${code} is only reachable via multi`);
    assert.equal(options.expected, code);
  }
});

test("non-medical languages fall back to general nova-3 monolingual", () => {
  const zh = resolveDeepgramOptions("zh");
  assert.equal(zh.model, "nova-3");
  assert.equal(zh.language, "zh");
  const ar = resolveDeepgramOptions("ar");
  assert.equal(ar.model, "nova-3");
  assert.equal(ar.language, "ar");
});

test("every catalogue entry resolves to a usable Deepgram request", () => {
  for (const { code } of listSupportedLanguages()) {
    const options = resolveDeepgramOptions(code);
    assert.ok(options.model, `${code} produced no model`);
    assert.ok(options.language, `${code} produced no language`);
    assert.ok(
      options.language === "multi" || options.language === code,
      `${code} resolved to an unexpected language parameter`
    );
  }
});

test("note language follows an explicit choice over what was detected", () => {
  assert.equal(resolveNoteLanguage({ selected: "es", detected: "en" }), "es");
});

test("note language falls back to detection when auto-detect was used", () => {
  assert.equal(resolveNoteLanguage({ selected: "auto", detected: "fr" }), "fr");
  assert.equal(resolveNoteLanguage({ selected: "", detected: "pt-BR" }), "pt");
});

test("note language defaults to English when nothing was detected", () => {
  assert.equal(resolveNoteLanguage({ selected: "auto", detected: "" }), "en");
  assert.equal(resolveNoteLanguage({}), "en");
});

test("language names are available for the note prompt", () => {
  assert.equal(getLanguageName("es"), "Spanish");
  assert.equal(getLanguageName("ja"), "Japanese");
  assert.equal(getLanguageName("nope"), "");
});

test("the catalogue advertises the ten medical languages plus auto", () => {
  const medical = listSupportedLanguages().filter((item) => item.medical).map((item) => item.code);
  assert.deepEqual(
    medical.filter((code) => code !== "auto").sort(),
    [...MEDICAL_LANGUAGES].sort()
  );
  assert.ok(medical.includes("auto"));
});
