import { authenticateAccessCookie, clearAuthCookies, readAccessPayload, readMfaChallenge } from "../services/authSessionService.js";
import { getUserById, isMfaRequiredForRole, isUserActive, isUserIdDeactivated } from "../services/userService.js";

// Runs before the MFA limiter so attempts throttle per account, not per IP.
export function attachMfaChallenge(req, _res, next) {
  const challenge = readMfaChallenge(req.headers?.cookie || "");
  if (challenge?.sub) req.mfaChallengeSubject = String(challenge.sub);
  next();
}

export async function resolveAuthenticatedUser(payload) {
  return getUserById(payload?.sub);
}

export async function requireAuth(req, res, next) {
  try {
    const auth = await authenticateAccessCookie(req.headers?.cookie || "");
    const user = auth ? await resolveAuthenticatedUser(auth.payload) : null;
    if (!auth || !user) {
      clearAuthCookies(res);
      // Deactivation revokes the session, so tell the holder why rather than
      // leaving them with a generic "session expired".
      const stale = readAccessPayload(req.headers?.cookie || "");
      if (stale?.sub && (await isUserIdDeactivated(stale.sub))) {
        res.status(403).json({ error: "This account has been deactivated.", code: "account_deactivated" });
        return;
      }
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    // User re-read per request, so deactivation bites on the next call.
    if (!isUserActive(user)) {
      clearAuthCookies(res);
      res.status(403).json({ error: "This account has been deactivated.", code: "account_deactivated" });
      return;
    }
    if (!user.verified) {
      res.status(403).json({ error: "Email not verified" });
      return;
    }
    // A role granted after the token was minted needs a fresh session.
    if (auth.payload.role !== user.role) {
      clearAuthCookies(res);
      res.status(401).json({ error: "Unauthorized", code: "role_changed" });
      return;
    }
    req.user = user;
    req.authSession = auth.session;
    req.authPayload = auth.payload;
    next();
  } catch {
    clearAuthCookies(res);
    res.status(401).json({ error: "Unauthorized" });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Admins are provisioned before they enrol, so the gate lives here:
  if (isMfaRequiredForRole(req.user.role) && !req.user.mfaEnabled) {
    res.status(403).json({
      error: "Set up two-factor authentication to use administrator features.",
      code: "mfa_enrollment_required",
    });
    return;
  }
  next();
}
