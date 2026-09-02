const SENSITIVE_KEY = /password|token|secret|authorization|cookie|otp|signature|transcript|soap|note|content/i;

function safeCode(value) {
  const code = String(value || "").trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : undefined;
}

function safeName(value) {
  const name = String(value || "Error").trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name) ? name : "Error";
}

function sanitizeContext(context = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(context || {})) {
    if (!safeCode(key) || SENSITIVE_KEY.test(key)) continue;
    if (typeof value === "boolean" || typeof value === "number") safe[key] = value;
    if (typeof value === "string" && safeCode(value)) safe[key] = value;
  }
  return safe;
}

export function logInfo(event, context = {}) {
  const record = {
    level: "info",
    event: safeCode(event) || "application.info",
    timestamp: new Date().toISOString(),
  };
  const safe = sanitizeContext(context);
  if (Object.keys(safe).length) record.context = safe;
  console.log(JSON.stringify(record));
}

export function logError(event, error, context = {}) {
  const record = {
    level: "error",
    event: safeCode(event) || "application.error",
    timestamp: new Date().toISOString(),
  };

  if (error) {
    record.error = {
      name: safeName(error?.name),
      code: safeCode(error?.code),
      status: Number.isInteger(error?.status) ? error.status : undefined,
    };
  }

  const safeContext = sanitizeContext(context);
  if (Object.keys(safeContext).length) record.context = safeContext;

  console.error(JSON.stringify(record));
}
