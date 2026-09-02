import {
  authenticateGoogleUser,
  authenticateUser,
  createUser,
  issueOtpForUser,
  updateUserProfile,
  verifyOtpForUser,
  findUserByEmail,
  issuePasswordResetForEmail,
  resetPasswordWithToken,
  changePassword as changePasswordForUser,
  requestEmailChange,
  confirmEmailChange,
  disconnectGoogle as disconnectGoogleForUser,
  getUserById,
  isUserActive,
  isUserIdDeactivated,
  beginMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
  getMfaStatus,
  regenerateRecoveryCodes,
  verifyMfaChallenge,
} from "../services/userService.js";
import { sendOtpEmail, sendPasswordResetEmail } from "../utils/mailer.js";
import { recordBaaSignature, maybeSendBaaEmail } from "../services/baaService.js";
import { getIpFromRequest, getCountryFromRequest } from "../utils/audit.js";
import { sendErrorResponse } from "../utils/errors.js";
import { logError } from "../utils/logging.js";
import {
  clearAuthCookies,
  clearMfaChallengeCookie,
  establishAuthSession,
  issueMfaChallenge,
  readAccessPayload,
  readMfaChallenge,
  refreshAuthSession,
  renewAccessCookie,
  revokeSessionFromCookies,
} from "../services/authSessionService.js";

async function getSessionUser(session) {
  if (!session) return null;
  return getUserById(session.subject);
}

function getAuditContext(req) {
  return {
    ipAddress: getIpFromRequest(req),
    country: getCountryFromRequest(req),
    userAgent: req.headers?.["user-agent"] || "",
  };
}

export async function signup(req, res) {
  try {
    const { firstName, lastName, email, password, baaOrganization, baaSignatoryName, baaSignatoryTitle, baaSignature } = req.body || {};
    // Self-signup always produces a provider.
    const result = await createUser({ firstName, lastName, email, password });
    if (baaSignature || baaSignatoryName) {
      // Capture the signed BAA now; it is emailed once the account is verified.
      await recordBaaSignature(
        result.user?._id,
        { organization: baaOrganization, signatoryName: baaSignatoryName, signatoryTitle: baaSignatoryTitle, signature: baaSignature },
        getAuditContext(req)
      ).catch((err) => logError("baa.signup_record_failed", err));
    }
    const code = await issueOtpForUser(result.user?._id);
    await sendOtpEmail(result.user?.email, code);
    res.json({ requiresVerification: true, email: result.user?.email });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to sign up", status: 400, event: "auth.signup_failed" });
  }
}

export async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    const result = await authenticateUser(email, password);
    if (!result?.user?.verified) {
      const code = await issueOtpForUser(result.user?._id);
      await sendOtpEmail(result.user?.email, code);
      res.json({ requiresVerification: true, email: result.user?.email });
      return;
    }
    if (result.mfaRequired) {
      // No auth cookies until the second factor clears.
      issueMfaChallenge(res, result.user);
      res.json({ requiresMfa: true, email: result.user?.email });
      return;
    }
    await establishAuthSession(res, result.user);
    res.json({ user: result.user });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to login", status: 400, event: "auth.login_failed" });
  }
}

export async function verifyMfa(req, res) {
  try {
    const challenge = readMfaChallenge(req.headers?.cookie || "");
    if (!challenge) {
      clearMfaChallengeCookie(res);
      res.status(401).json({ error: "Your sign-in request expired. Start again.", code: "mfa_challenge_expired" });
      return;
    }
    const { code } = req.body || {};
    const result = await verifyMfaChallenge(challenge.sub, code);
    clearMfaChallengeCookie(res);
    await establishAuthSession(res, result.user);
    res.json({ user: result.user });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to verify code", status: 400, event: "auth.mfa_verify_failed" });
  }
}

export async function getMfa(req, res) {
  try {
    res.json(await getMfaStatus(req.user?._id));
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to load two-factor status", status: 400, event: "auth.mfa_status_failed" });
  }
}

export async function startMfaEnrollment(req, res) {
  try {
    res.json(await beginMfaEnrollment(req.user?._id));
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to start two-factor setup", status: 400, event: "auth.mfa_enroll_failed" });
  }
}

export async function confirmMfa(req, res) {
  try {
    const { code } = req.body || {};
    const { recoveryCodes } = await confirmMfaEnrollment(req.user?._id, code);
    const status = await getMfaStatus(req.user?._id);
    res.json({ ...status, recoveryCodes });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to confirm two-factor setup", status: 400, event: "auth.mfa_confirm_failed" });
  }
}

export async function turnOffMfa(req, res) {
  try {
    const { password, code } = req.body || {};
    res.json(await disableMfa(req.user?._id, { password, code }));
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to disable two-factor", status: 400, event: "auth.mfa_disable_failed" });
  }
}

export async function refreshRecoveryCodes(req, res) {
  try {
    const { code } = req.body || {};
    res.json(await regenerateRecoveryCodes(req.user?._id, code));
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to regenerate recovery codes", status: 400, event: "auth.mfa_recovery_failed" });
  }
}

export async function me(req, res) {
  res.json({ user: req.user });
}

export async function refreshSession(req, res) {
  try {
    const session = await refreshAuthSession(req.headers?.cookie || "", res);
    const user = await getSessionUser(session);
    if (!session || !user || !user.verified) {
      clearAuthCookies(res);
      const stale = readAccessPayload(req.headers?.cookie || "");
      if (stale?.sub && (await isUserIdDeactivated(stale.sub))) {
        res.status(403).json({ error: "This account has been deactivated.", code: "account_deactivated" });
        return;
      }
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    // A refresh must not resurrect access for a deactivated or re-roled account.
    if (!isUserActive(user)) {
      clearAuthCookies(res);
      res.status(403).json({ error: "This account has been deactivated.", code: "account_deactivated" });
      return;
    }
    if (session.role !== user.role) {
      clearAuthCookies(res);
      res.status(401).json({ error: "Unauthorized", code: "role_changed" });
      return;
    }
    req.user = user;
    res.json({ user });
  } catch (err) {
    clearAuthCookies(res);
    sendErrorResponse(res, err, { fallback: "Unauthorized", status: 401, event: "auth.refresh_failed" });
  }
}

export async function logout(req, res) {
  try {
    const session = await revokeSessionFromCookies(req.headers?.cookie || "");
    req.user = await getSessionUser(session);
  } catch (err) {
    logError("auth.logout_revoke_failed", err);
  } finally {
    clearAuthCookies(res);
    res.json({ status: "ok" });
  }
}

export async function touchSession(req, res) {
  renewAccessCookie(res, req.authSession);
  res.json({ status: "ok" });
}

export async function updateProfile(req, res) {
  try {
    const { baaOrganization, baaSignatoryName, baaSignatoryTitle, baaSignature } = req.body || {};
    // Sign the BAA here for users who never saw the signup modal (e.g. Google sign-up).
    if (!req.user?.baa?.signed && (baaSignature || baaSignatoryName)) {
      await recordBaaSignature(
        req.user?._id,
        { organization: baaOrganization, signatoryName: baaSignatoryName, signatoryTitle: baaSignatoryTitle, signature: baaSignature },
        getAuditContext(req)
      );
    }
    const user = await updateUserProfile(req.user?._id, req.body || {});
    // Google users are already verified, so the BAA can be emailed immediately.
    maybeSendBaaEmail(req.user?._id, getAuditContext(req)).catch((err) =>
      logError("baa.profile_email_failed", err)
    );
    res.json({ user });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to update profile", status: 400, event: "auth.profile_update_failed" });
  }
}

export async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const user = await changePasswordForUser(req.user?._id, currentPassword, newPassword);
    await establishAuthSession(res, user);
    res.json({ user, message: "Password updated" });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to change password", status: 400, event: "auth.password_change_failed" });
  }
}

export async function changeEmail(req, res) {
  try {
    const { newEmail, currentPassword } = req.body || {};
    const { code, pendingEmail } = await requestEmailChange(req.user?._id, newEmail, currentPassword);
    await sendOtpEmail(pendingEmail, code);
    res.json({ requiresVerification: true, pendingEmail });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to start email change", status: 400, event: "auth.email_change_failed" });
  }
}

export async function verifyEmailChange(req, res) {
  try {
    const { code } = req.body || {};
    const user = await confirmEmailChange(req.user?._id, code);
    if (!user) {
      res.status(400).json({ error: "Invalid or expired code" });
      return;
    }
    await establishAuthSession(res, user);
    res.json({ user, message: "Email updated" });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to verify email change", status: 400, event: "auth.email_verify_failed" });
  }
}

export async function disconnectGoogle(req, res) {
  try {
    const user = await disconnectGoogleForUser(req.user?._id);
    await establishAuthSession(res, user);
    res.json({ user, message: "Google disconnected" });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to disconnect Google", status: 400, event: "auth.google_disconnect_failed" });
  }
}

export async function sendOtp(req, res) {
  try {
    const { email } = req.body || {};
    const user = await findUserByEmail(email);
    if (!user) {
      res.json({ message: "If an account exists for this email, an OTP has been sent." });
      return;
    }
    const code = await issueOtpForUser(user._id);
    await sendOtpEmail(user.email, code);
    res.json({ message: "If an account exists for this email, an OTP has been sent." });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to send OTP", status: 400, event: "auth.otp_send_failed" });
  }
}

export async function verifyOtp(req, res) {
  try {
    const { email, code } = req.body || {};
    const user = await findUserByEmail(email);
    if (!user) {
      res.status(400).json({ error: "Invalid or expired OTP" });
      return;
    }
    const verified = await verifyOtpForUser(user._id, code);
    if (!verified) {
      res.status(400).json({ error: "Invalid or expired OTP" });
      return;
    }
    await establishAuthSession(res, verified.user);
    // Now that the email is confirmed, email the signed BAA (idempotent).
    maybeSendBaaEmail(user._id, getAuditContext(req)).catch((err) =>
      logError("baa.verification_email_failed", err)
    );
    res.json(verified);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to verify OTP", status: 400, event: "auth.otp_verify_failed" });
  }
}

function getClientBaseUrl(req) {
  const envBase = String(process.env.CLIENT_APP_URL || "").trim().replace(/\/$/, "");
  if (envBase) return envBase;
  const origin = String(req.headers?.origin || "").trim().replace(/\/$/, "");
  if (origin) return origin;
  return `${req.protocol}://${req.get("host")}`;
}

export async function forgotPassword(req, res) {
  try {
    const { email } = req.body || {};
    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }
    const payload = await issuePasswordResetForEmail(email);
    if (payload?.token && payload?.user?.email) {
      const resetLink = `${getClientBaseUrl(req)}/reset-password?token=${encodeURIComponent(payload.token)}`;
      await sendPasswordResetEmail(payload.user.email, resetLink);
    }
    res.json({ message: "If an account exists for this email, a password reset link has been sent." });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to process forgot password", status: 400, event: "auth.password_reset_request_failed" });
  }
}

export async function resetPassword(req, res) {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      res.status(400).json({ error: "Token and password are required" });
      return;
    }
    const user = await resetPasswordWithToken(token, password);
    if (!user) {
      res.status(400).json({ error: "Invalid or expired reset token" });
      return;
    }
    clearAuthCookies(res);
    res.json({ message: "Password has been reset successfully." });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to reset password", status: 400, event: "auth.password_reset_failed" });
  }
}

export async function googleCallback(req, res) {
  const authPayload = req.user;
  if (!authPayload?.user) {
    res.redirect(`${getClientBaseUrl(req)}/login?error=${encodeURIComponent("Google authentication failed")}`);
    return;
  }
  const redirectBase = getClientBaseUrl(req);
  try {
    // Google proves the first factor only; an enrolled account still owes TOTP.
    if (authPayload.mfaRequired) {
      issueMfaChallenge(res, authPayload.user);
      res.redirect(`${redirectBase}/auth/google/callback?mfa=1`);
      return;
    }
    await establishAuthSession(res, authPayload.user);
    res.redirect(`${redirectBase}/auth/google/callback?success=1`);
  } catch (err) {
    logError("auth.google_session_failed", err);
    clearAuthCookies(res);
    res.redirect(`${redirectBase}/login?error=${encodeURIComponent("Google authentication failed")}`);
  }
}

export function googleFailure(req, res) {
  res.redirect(`${getClientBaseUrl(req)}/login?error=${encodeURIComponent("Google authentication failed")}`);
}

export async function verifyGoogleProfile(profile) {
  const email = profile?.emails?.[0]?.value || "";
  const googleId = profile?.id || "";
  const firstName = profile?.name?.givenName || profile?.displayName || "User";
  const lastName = profile?.name?.familyName || "";
  return authenticateGoogleUser({ googleId, email, firstName, lastName });
}
