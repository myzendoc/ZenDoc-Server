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
} from "../services/userService.js";
import { sendOtpEmail, sendPasswordResetEmail } from "../utils/mailer.js";
import { recordBaaSignature, maybeSendBaaEmail } from "../services/baaService.js";
import { getIpFromRequest, getCountryFromRequest } from "../utils/audit.js";

function getAuditContext(req) {
  return {
    ipAddress: getIpFromRequest(req),
    country: getCountryFromRequest(req),
    userAgent: req.headers?.["user-agent"] || "",
  };
}

function resolveRole(adminCode) {
  if (adminCode && process.env.ADMIN_INVITE_CODE && adminCode === process.env.ADMIN_INVITE_CODE) {
    return "admin";
  }
  return "provider";
}

export async function signup(req, res) {
  try {
    const { firstName, lastName, email, password, adminCode, baaOrganization, baaSignatoryName, baaSignatoryTitle, baaSignature } = req.body || {};
    const role = resolveRole(adminCode);
    const result = await createUser({ firstName, lastName, email, password, role });
    if (baaSignature || baaSignatoryName) {
      // Capture the signed BAA now; it is emailed once the account is verified.
      await recordBaaSignature(
        result.user?._id,
        { organization: baaOrganization, signatoryName: baaSignatoryName, signatoryTitle: baaSignatoryTitle, signature: baaSignature },
        getAuditContext(req)
      ).catch((err) => console.error("Failed to record BAA at signup:", err.message));
    }
    const code = await issueOtpForUser(result.user?._id);
    await sendOtpEmail(result.user?.email, code);
    res.json({ requiresVerification: true, email: result.user?.email });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to sign up" });
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
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to login" });
  }
}

export async function me(req, res) {
  res.json({ user: req.user });
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
      console.error("Failed to send BAA email after profile update:", err.message)
    );
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to update profile" });
  }
}

export async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const user = await changePasswordForUser(req.user?._id, currentPassword, newPassword);
    res.json({ user, message: "Password updated" });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to change password" });
  }
}

export async function changeEmail(req, res) {
  try {
    const { newEmail, currentPassword } = req.body || {};
    const { code, pendingEmail } = await requestEmailChange(req.user?._id, newEmail, currentPassword);
    await sendOtpEmail(pendingEmail, code);
    res.json({ requiresVerification: true, pendingEmail });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to start email change" });
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
    res.json({ user, message: "Email updated" });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to verify email change" });
  }
}

export async function disconnectGoogle(req, res) {
  try {
    const user = await disconnectGoogleForUser(req.user?._id);
    res.json({ user, message: "Google disconnected" });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to disconnect Google" });
  }
}

export async function sendOtp(req, res) {
  try {
    const { email } = req.body || {};
    const user = await findUserByEmail(email);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const code = await issueOtpForUser(user._id);
    await sendOtpEmail(user.email, code);
    res.json({ message: "OTP sent", email: user.email });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to send OTP" });
  }
}

export async function verifyOtp(req, res) {
  try {
    const { email, code } = req.body || {};
    const user = await findUserByEmail(email);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const verified = await verifyOtpForUser(user._id, code);
    if (!verified) {
      res.status(400).json({ error: "Invalid or expired OTP" });
      return;
    }
    // Now that the email is confirmed, email the signed BAA (idempotent).
    maybeSendBaaEmail(user._id, getAuditContext(req)).catch((err) =>
      console.error("Failed to send BAA email after verification:", err.message)
    );
    res.json(verified);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to verify OTP" });
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
    res.status(400).json({ error: err.message || "Failed to process forgot password" });
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
    res.json({ message: "Password has been reset successfully." });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to reset password" });
  }
}

export async function googleCallback(req, res) {
  const authPayload = req.user;
  if (!authPayload?.token) {
    res.redirect(`${getClientBaseUrl(req)}/login?error=${encodeURIComponent("Google authentication failed")}`);
    return;
  }
  const redirectBase = getClientBaseUrl(req);
  res.redirect(`${redirectBase}/auth/google/callback?token=${encodeURIComponent(authPayload.token)}`);
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
