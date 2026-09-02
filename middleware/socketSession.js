import { authenticateAccessCookie, validateAuthSession } from "../services/authSessionService.js";
import { getUserById, isUserActive } from "../services/userService.js";

const REVALIDATE_INTERVAL_MS = 60 * 1000;

export async function authenticateSocketSession(socket) {
  const result = await authenticateAccessCookie(socket.handshake?.headers?.cookie || "");
  const user = result ? await getUserById(result.payload?.sub) : null;
  if (!result || !user?.verified || !isUserActive(user)) return null;
  const actorName =
    String(user.displayName || "").trim() ||
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    String(user.firstName || "").trim();
  return {
    sessionId: String(result.session._id),
    userId: String(result.payload.sub),
    role: user.role === "admin" ? "admin" : "provider",
    actorEmail: String(user.email || "").trim().toLowerCase() || null,
    actorName: actorName || null,
    checkedAt: Date.now(),
  };
}

export async function revalidateSocketSession(socket) {
  const auth = socket.data?.auth;
  if (!auth) return null;
  if (auth.checkedAt + REVALIDATE_INTERVAL_MS > Date.now()) return auth;
  const session = await validateAuthSession(auth.sessionId, auth.userId);
  if (!session) {
    socket.data.auth = null;
    socket.disconnect(true);
    return null;
  }
  // Backstop for a socket that outlived the revocation sweep.
  const user = await getUserById(auth.userId);
  if (!user || !isUserActive(user)) {
    socket.data.auth = null;
    socket.disconnect(true);
    return null;
  }
  auth.checkedAt = Date.now();
  return auth;
}
