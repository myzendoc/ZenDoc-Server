function coerceString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeIp(raw) {
  const value = coerceString(raw);
  if (!value) return "";
  if (value === "::1") return "127.0.0.1";
  return value.replace(/^::ffff:/, "");
}

function readHeader(headers = {}, names = []) {
  for (const name of names) {
    const value = headers?.[name];
    if (Array.isArray(value) && value.length) return coerceString(value[0]);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function getCountryName(value) {
  const country = coerceString(value);
  if (!country || country === "XX" || country === "T1") return "";
  if (!/^[a-z]{2}$/i.test(country)) return country;
  const code = country.toUpperCase();
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

function getCountryFromLanguage(value) {
  const language = coerceString(value).split(",")[0]?.split(";")[0]?.trim();
  const match = language?.match(/[-_]([a-z]{2})$/i);
  return match ? getCountryName(match[1]) : "";
}

function getCountryFromHeaders(headers = {}) {
  const country = readHeader(headers, [
    "cf-ipcountry",
    "x-vercel-ip-country",
    "x-appengine-country",
    "x-country-code",
    "x-client-country",
  ]);
  return getCountryName(country) || getCountryFromLanguage(readHeader(headers, ["accept-language"]));
}

export function getIpFromRequest(req) {
  const forwarded = req.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }
  if (Array.isArray(forwarded) && forwarded.length) {
    const first = forwarded[0]?.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress);
}

export function getIpFromSocket(socket) {
  const forwarded = socket?.handshake?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(socket?.handshake?.address || socket?.conn?.remoteAddress);
}

export function getCountryFromRequest(req) {
  return getCountryFromHeaders(req?.headers);
}

export function getCountryFromSocket(socket) {
  return getCountryName(socket?.handshake?.auth?.country) || getCountryFromHeaders(socket?.handshake?.headers);
}

export function parseBrowserFromUserAgent(userAgent = "") {
  const ua = String(userAgent || "");
  if (!ua) return "Unknown";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua) || /Opera/i.test(ua)) return "Opera";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua) && !/OPR\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return "Safari";
  if (/MSIE|Trident/i.test(ua)) return "Internet Explorer";
  return "Unknown";
}

export function getSocketAuditActor(socket, payload = {}) {
  const auth = socket?.data?.auth;
  const membership = socket?.data?.meeting;
  const userAgent = String(socket?.handshake?.headers?.["user-agent"] || "");
  const membershipRole = membership?.role === "admin" ? "admin" : membership?.role === "creator" ? "provider" : "guest";
  return {
    actorUserId: auth?.userId || membership?.userId || null,
    actorRole: auth?.role || membershipRole,
    actorEmail: auth?.actorEmail || null,
    actorName: auth?.actorName || membership?.username || (payload?.username ? String(payload.username) : null),
    ipAddress: getIpFromSocket(socket),
    country: getCountryFromSocket(socket),
    userAgent,
    browser: parseBrowserFromUserAgent(userAgent),
    method: "SOCKET",
  };
}

export function getResourceTypeFromPath(path = "") {
  const cleaned = String(path || "").split("?")[0];
  const parts = cleaned.split("/").filter(Boolean);
  if (parts[0] === "api") return parts[1] || "api";
  return parts[0] || "api";
}
