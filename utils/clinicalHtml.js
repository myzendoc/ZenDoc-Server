import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "p",
  "br",
  "div",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

const SOAP_CONTENT_KEYS = new Set(["subjective", "objective", "assessment", "plan", "note"]);

export function sanitizeClinicalHtml(value) {
  return sanitizeHtml(String(value || ""), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {},
    allowedSchemes: [],
    disallowedTagsMode: "discard",
  });
}

export function sanitizeSoapContent(content) {
  const source = typeof content === "string" ? { note: content } : content;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => SOAP_CONTENT_KEYS.has(key))
      .map(([key, value]) => [key, sanitizeClinicalHtml(value)])
  );
}

export function sanitizeSoapNote(note) {
  if (!note) return null;
  const plain = typeof note.toObject === "function" ? note.toObject() : { ...note };
  plain.content = sanitizeSoapContent(plain.content);
  return plain;
}
