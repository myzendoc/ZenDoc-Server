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

export function getResourceTypeFromPath(path = "") {
  const cleaned = String(path || "").split("?")[0];
  const parts = cleaned.split("/").filter(Boolean);
  if (parts[0] === "api") return parts[1] || "api";
  return parts[0] || "api";
}
