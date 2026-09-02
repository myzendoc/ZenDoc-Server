import { logError } from "../utils/logging.js";

// index.js owns the socket.io server, but account changes originate in the service layer.
let disconnector = null;

export function registerSocketDisconnector(fn) {
  disconnector = typeof fn === "function" ? fn : null;
}

export async function disconnectUserSockets(userId, reason = "session_revoked") {
  const subject = String(userId || "").trim();
  if (!subject || !disconnector) return 0;
  try {
    return (await disconnector(subject, reason)) || 0;
  } catch (err) {
    logError("session.socket_disconnect_failed", err);
    return 0;
  }
}
