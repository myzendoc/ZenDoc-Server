function configuredOrigins() {
  const values = [process.env.CLIENT_APP_URL, process.env.ALLOWED_ORIGINS]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return new Set([
    "https://myzendoc.com",
    "https://www.myzendoc.com",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...values,
  ]);
}

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  return configuredOrigins().has(String(origin).replace(/\/$/, ""));
}

export function applyCors(req, res, next) {
  const origin = req.headers?.origin;
  if (!isAllowedOrigin(origin)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  if (origin) res.header("Access-Control-Allow-Origin", origin);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}
