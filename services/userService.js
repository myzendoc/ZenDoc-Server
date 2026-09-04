import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import { User } from "../models/user.js";
import { Meeting } from "../models/meeting.js";
import { MeetingSession } from "../models/meetingSession.js";
import { publicError } from "../utils/errors.js";
import { revokeAllSessionsForSubject } from "./authSessionService.js";
import { disconnectUserSockets } from "./sessionRevocation.js";
import { setSubscriptionCancelAtPeriodEnd } from "./billingService.js";
import { revokeAllTrustedDevices } from "./trustedDeviceService.js";
import { logError } from "../utils/logging.js";
import { decryptField, encryptField } from "../utils/fieldCipher.js";
import {
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotpCode,
} from "../utils/totp.js";

// OWASP guidance for PBKDF2-HMAC-SHA512.
const ITERATIONS = 210000;
const LEGACY_ITERATIONS = 120000;
const OTP_TTL_MINUTES = 10;
const RESET_PASSWORD_TTL_MINUTES = 30;
const MFA_SECRET_CONTEXT = "User.mfa.secret";
export const MAX_LOGIN_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

export function getNextLoginFailureState(currentFailures = 0, now = Date.now()) {
  const failures = Math.max(0, Number(currentFailures) || 0) + 1;
  if (failures >= MAX_LOGIN_FAILURES) {
    return { failedLoginAttempts: 0, loginLockedUntil: new Date(now + LOGIN_LOCK_MS) };
  }
  return { failedLoginAttempts: failures, loginLockedUntil: undefined };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex"), iterations = ITERATIONS) {
  const derived = crypto.pbkdf2Sync(password, salt, iterations, 64, "sha512").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${derived}`;
}

// Legacy hashes are `salt:derived`; current ones carry their cost factor.
function parseStoredPassword(stored) {
  const value = String(stored || "");
  if (value.startsWith("pbkdf2$")) {
    const [, iterations, salt, hash] = value.split("$");
    const rounds = Number(iterations);
    if (!Number.isInteger(rounds) || rounds <= 0 || !salt || !hash) return null;
    return { iterations: rounds, salt, hash, legacy: false };
  }
  const [salt, hash] = value.split(":");
  if (!salt || !hash) return null;
  return { iterations: LEGACY_ITERATIONS, salt, hash, legacy: true };
}

function verifyPassword(password, stored) {
  if (!password || !stored) return false;
  const parsed = parseStoredPassword(stored);
  if (!parsed) return false;
  const derived = crypto.pbkdf2Sync(password, parsed.salt, parsed.iterations, 64, "sha512").toString("hex");
  const expected = Buffer.from(parsed.hash);
  const actual = Buffer.from(derived);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function needsPasswordRehash(stored) {
  const parsed = parseStoredPassword(stored);
  return !parsed || parsed.legacy || parsed.iterations < ITERATIONS;
}

// Exposed for scripts/manageAdmin.js, which writes users outside the HTTP layer.
export function hashPasswordForScript(password) {
  return hashPassword(password);
}

function extractRoomCode(value = "") {
  const input = String(value || "").trim();
  if (!input) return "";
  if (!/^https?:\/\//i.test(input)) return input.replace(/^\/+/, "").split(/[/?#]/)[0];
  try {
    const parsed = new URL(input);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const roomIndex = segments.findIndex((segment) => segment === "room");
    if (roomIndex !== -1 && segments[roomIndex + 1]) return segments[roomIndex + 1];
    return segments[0] || "";
  } catch {
    return "";
  }
}

export function sanitizeUser(user) {
  if (!user) return null;
  const hadPassword = Boolean(user.password);
  // Lean reads hand back the caller's object, so copy before deleting fields.
  const obj = user.toObject ? user.toObject() : { ...user };
  if (obj.baa) obj.baa = { ...obj.baa };
  delete obj.password;
  delete obj.otpCode;
  delete obj.otpExpires;
  delete obj.emailChangeOtp;
  delete obj.emailChangeOtpExpires;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpires;
  delete obj.failedLoginAttempts;
  delete obj.loginLockedUntil;
  // MFA secret and recovery hashes must never reach a response body.
  obj.mfaEnabled = Boolean(obj.mfa?.enabled);
  delete obj.mfa;
  // The drawn signature is an identity artifact; clients only need the flag.
  if (obj.baa) delete obj.baa.signature;
  obj.hasPassword = hadPassword;
  obj.isActive = obj.status !== "deactivated";
  return obj;
}

export function isUserActive(user) {
  return Boolean(user) && user.status !== "deactivated";
}

export async function isUserIdActive(userId) {
  if (!userId) return false;
  const user = await User.findById(userId).select("status").lean();
  return isUserActive(user);
}

// Distinct from !isUserIdActive: a missing user is not a deactivated one.
export async function isUserIdDeactivated(userId) {
  if (!userId) return false;
  if (!mongoose.Types.ObjectId.isValid(String(userId))) return false;
  const user = await User.findById(userId).select("status").lean();
  return Boolean(user) && user.status === "deactivated";
}

export async function createUser({ firstName, lastName, email, password }) {
  if (!firstName || !email || !password) throw publicError("Missing required fields");
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw new Error("User already exists");
  const hashed = hashPassword(password);
  // Role is never taken from the signup payload.
  const user = await User.create({
    firstName,
    lastName,
    email: email.toLowerCase(),
    password: hashed,
    role: "provider",
    status: "active",
    onboardingComplete: false,
    verified: false,
  });
  return { user: sanitizeUser(user) };
}

export async function authenticateUser(email, password) {
  if (!email || !password) throw publicError("Missing credentials");
  const user = await User.findOne({ email: email.toLowerCase() }).select("+failedLoginAttempts +loginLockedUntil");
  if (!user) throw publicError("Invalid credentials");
  const now = Date.now();
  const lockedUntil = user.loginLockedUntil ? user.loginLockedUntil.getTime() : 0;
  if (lockedUntil > now) {
    const error = publicError("Too many failed login attempts. Try again later.", 429);
    error.retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil - now) / 1000));
    throw error;
  }
  if (lockedUntil) {
    user.loginLockedUntil = undefined;
    user.failedLoginAttempts = 0;
    await User.updateOne(
      { _id: user._id },
      { $set: { failedLoginAttempts: 0 }, $unset: { loginLockedUntil: 1 } }
    );
  }
  if (!user.password) throw publicError("Use Google sign-in for this account");
  const valid = verifyPassword(password, user.password);
  if (!valid) {
    const updated = await User.findByIdAndUpdate(
      user._id,
      { $inc: { failedLoginAttempts: 1 } },
      { new: true }
    ).select("+failedLoginAttempts +loginLockedUntil");
    const failureState = getNextLoginFailureState(Number(updated?.failedLoginAttempts || 1) - 1, now);
    if (failureState.loginLockedUntil) {
      await User.updateOne(
        { _id: user._id },
        {
          $set: { failedLoginAttempts: 0, loginLockedUntil: failureState.loginLockedUntil },
        }
      );
      const error = publicError("Too many failed login attempts. Try again later.", 429);
      error.retryAfterSeconds = Math.ceil(LOGIN_LOCK_MS / 1000);
      throw error;
    }
    throw publicError("Invalid credentials");
  }
  if (user.failedLoginAttempts || user.loginLockedUntil) {
    await User.updateOne(
      { _id: user._id },
      { $set: { failedLoginAttempts: 0 }, $unset: { loginLockedUntil: 1 } }
    );
  }
  // Checked after the password, so deactivation isn't an enumeration oracle.
  if (!isUserActive(user)) {
    throw publicError("This account has been deactivated. Contact your administrator.", 403);
  }
  if (needsPasswordRehash(user.password)) {
    await User.updateOne({ _id: user._id }, { $set: { password: hashPassword(password) } });
  }
  return { user: sanitizeUser(user), mfaRequired: Boolean(user.mfa?.enabled) };
}

export async function authenticateGoogleUser({ googleId, email, firstName, lastName }) {
  const normalizedEmail = String(email || "").toLowerCase().trim();
  if (!googleId || !normalizedEmail) throw new Error("Missing Google profile");

  let user = await User.findOne({ googleId });
  if (!user) {
    user = await User.findOne({ email: normalizedEmail });
  }

  if (user) {
    if (!isUserActive(user)) {
      throw publicError("This account has been deactivated. Contact your administrator.", 403);
    }
    if (!user.googleId) user.googleId = googleId;
    if (!user.firstName && firstName) user.firstName = firstName;
    if (!user.lastName && lastName) user.lastName = lastName;
    user.authProvider = "google";
    user.verified = true;
    await user.save();
  } else {
    user = await User.create({
      firstName: firstName || "User",
      lastName: lastName || "",
      email: normalizedEmail,
      googleId,
      authProvider: "google",
      onboardingComplete: false,
      verified: true,
      role: "provider",
      status: "active",
    });
  }

  return { user: sanitizeUser(user), mfaRequired: Boolean(user.mfa?.enabled) };
}

export async function findUserByEmail(email) {
  if (!email) return null;
  const user = await User.findOne({ email: email.toLowerCase() });
  return user;
}

export async function getUserById(id) {
  if (!id) return null;
  const user = await User.findById(id);
  return sanitizeUser(user);
}

export async function updateUserProfile(userId, payload = {}) {
  if (!userId) return null;
  const updates = {};
  if (payload.firstName) updates.firstName = payload.firstName;
  if (payload.lastName !== undefined) updates.lastName = payload.lastName;
  if (payload.displayName !== undefined) updates.displayName = payload.displayName;
  if (payload.meetingUrl !== undefined) updates.meetingUrl = payload.meetingUrl;
  if (payload.npiNumber !== undefined) updates.npiNumber = String(payload.npiNumber).trim();
  if (payload.primarySpecialty !== undefined) updates.primarySpecialty = String(payload.primarySpecialty).trim();
  if (payload.statesLicensed !== undefined) {
    updates.statesLicensed = Array.isArray(payload.statesLicensed)
      ? payload.statesLicensed.map((s) => String(s).trim()).filter(Boolean)
      : [];
  }
  if (Object.keys(updates).length === 0) return getUserById(userId);
  if (updates.firstName || updates.displayName || updates.meetingUrl) updates.onboardingComplete = true;
  const user = await User.findByIdAndUpdate(userId, { $set: updates }, { new: true });
  if (updates.meetingUrl) {
    const roomId = extractRoomCode(updates.meetingUrl);
    if (roomId) {
      await Meeting.findOneAndUpdate(
        { roomId },
        { $setOnInsert: { roomId, createdBy: userId } },
        { new: true, upsert: true }
      );
    }
  }
  return sanitizeUser(user);
}

export async function listUsersWithMeetingCounts() {
  const users = await User.find({}).sort({ createdAt: -1 }).lean();
  const meetingCounts = await MeetingSession.aggregate([
    { $match: { createdBy: { $exists: true, $ne: null } } },
    {
      $project: {
        createdBy: 1,
        startedAt: 1,
        durationMs: {
          $max: [
            {
              $subtract: [
                { $ifNull: ["$endedAt", "$startedAt"] },
                { $ifNull: ["$startedAt", "$createdAt"] },
              ],
            },
            0,
          ],
        },
      },
    },
    {
      $group: {
        _id: "$createdBy",
        count: { $sum: 1 },
        lastMeetingAt: { $max: "$startedAt" },
        totalDurationMs: { $sum: "$durationMs" },
      },
    },
  ]);
  const countMap = new Map(meetingCounts.map((item) => [String(item._id), item]));
  return users.map((user) => {
    const stats = countMap.get(String(user._id)) || {};
    return {
      ...sanitizeUser(user),
      meetingCount: stats.count || 0,
      lastMeetingAt: stats.lastMeetingAt || null,
      totalMeetingSeconds: Math.max(0, Math.floor((stats.totalDurationMs || 0) / 1000)),
    };
  });
}

function generateOtpCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function hashOtp(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueOtpForUser(userId) {
  if (!userId) throw new Error("Missing user");
  const code = generateOtpCode();
  const hashed = hashOtp(code);
  const expires = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  await User.findByIdAndUpdate(userId, { $set: { otpCode: hashed, otpExpires: expires } });
  return code;
}

export async function verifyOtpForUser(userId, code) {
  if (!userId || !code) return null;
  const user = await User.findById(userId);
  if (!user) return null;
  if (!isUserActive(user)) {
    throw publicError("This account has been deactivated. Contact your administrator.", 403);
  }
  if (!user.otpCode || !user.otpExpires) return null;
  if (user.otpExpires.getTime() < Date.now()) return null;
  const matches = user.otpCode === hashOtp(code);
  if (!matches) return null;
  user.verified = true;
  user.otpCode = undefined;
  user.otpExpires = undefined;
  await user.save();
  return { user: sanitizeUser(user) };
}

export async function issuePasswordResetForEmail(email) {
  if (!email) return null;
  const user = await User.findOne({ email: String(email).toLowerCase() });
  // Silent no-op for deactivated accounts: a reset must not become a way back in.
  if (!user || !isUserActive(user)) return null;
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashResetToken(rawToken);
  const expires = new Date(Date.now() + RESET_PASSWORD_TTL_MINUTES * 60 * 1000);
  user.resetPasswordToken = tokenHash;
  user.resetPasswordExpires = expires;
  await user.save();
  return { user: sanitizeUser(user), token: rawToken, expiresAt: expires };
}

export async function resetPasswordWithToken(token, password) {
  const tokenInput = String(token || "").trim();
  const passwordInput = String(password || "");
  if (!tokenInput || !passwordInput) return null;
  const hashedToken = hashResetToken(tokenInput);
  const user = await User.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpires: { $gt: new Date() },
  });
  if (!user || !isUserActive(user)) return null;
  user.password = hashPassword(passwordInput);
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
  await user.save();
  await revokeAllSessionsForSubject(user.id);
  await revokeAllTrustedDevices(user._id);
  return sanitizeUser(user);
}

export async function changePassword(userId, currentPassword, newPassword) {
  if (!userId) throw new Error("Missing user");
  const next = String(newPassword || "");
  if (next.length < 8) throw publicError("New password must be at least 8 characters");
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  // Users who signed up with Google have no password yet and may set one without a current password.
  if (user.password) {
    if (!verifyPassword(String(currentPassword || ""), user.password)) {
      throw publicError("Current password is incorrect");
    }
  }
  user.password = hashPassword(next);
  await user.save();
  await revokeAllSessionsForSubject(user.id);
  await revokeAllTrustedDevices(user._id);
  return sanitizeUser(user);
}

export async function requestEmailChange(userId, newEmail, currentPassword) {
  if (!userId) throw new Error("Missing user");
  const normalized = String(newEmail || "").toLowerCase().trim();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw publicError("Enter a valid email address");
  }
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  if (normalized === user.email) throw publicError("That is already your email address");
  if (user.password) {
    if (!verifyPassword(String(currentPassword || ""), user.password)) {
      throw publicError("Current password is incorrect");
    }
  }
  const existing = await User.findOne({ email: normalized });
  if (existing) throw publicError("That email address is already in use");
  const code = generateOtpCode();
  user.pendingEmail = normalized;
  user.emailChangeOtp = hashOtp(code);
  user.emailChangeOtpExpires = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  await user.save();
  return { code, pendingEmail: normalized };
}

export async function confirmEmailChange(userId, code) {
  if (!userId || !code) return null;
  const user = await User.findById(userId);
  if (!user || !user.pendingEmail || !user.emailChangeOtp || !user.emailChangeOtpExpires) return null;
  if (user.emailChangeOtpExpires.getTime() < Date.now()) return null;
  if (user.emailChangeOtp !== hashOtp(code)) return null;
  // Re-check availability in case the address was claimed during the window.
  const existing = await User.findOne({ email: user.pendingEmail });
  if (existing && String(existing._id) !== String(user._id)) {
    throw publicError("That email address is already in use");
  }
  user.email = user.pendingEmail;
  user.verified = true;
  user.pendingEmail = undefined;
  user.emailChangeOtp = undefined;
  user.emailChangeOtpExpires = undefined;
  await user.save();
  await revokeAllSessionsForSubject(user.id);
  return sanitizeUser(user);
}

export async function disconnectGoogle(userId) {
  if (!userId) throw new Error("Missing user");
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  if (!user.googleId) throw publicError("Google is not connected to this account");
  if (!user.password) {
    throw publicError("Set a password before disconnecting Google so you can still sign in");
  }
  user.googleId = undefined;
  user.authProvider = "local";
  await user.save();
  await revokeAllSessionsForSubject(user.id);
  return sanitizeUser(user);
}



const MFA_FIELDS = "+mfa.secret +mfa.pendingSecret +mfa.recoveryCodes +mfa.lastUsedStep";

export function isMfaRequiredForRole(role) {
  return role === "admin";
}

export async function getMfaStatus(userId) {
  const user = await User.findById(userId).select(MFA_FIELDS).lean();
  if (!user) throw publicError("User not found", 404);
  const remaining = (user.mfa?.recoveryCodes || []).filter((entry) => !entry.usedAt).length;
  return {
    enabled: Boolean(user.mfa?.enabled),
    required: isMfaRequiredForRole(user.role),
    confirmedAt: user.mfa?.confirmedAt || null,
    recoveryCodesRemaining: remaining,
  };
}

export async function beginMfaEnrollment(userId) {
  const user = await User.findById(userId);
  if (!user) throw publicError("User not found", 404);
  if (user.mfa?.enabled) throw publicError("Two-factor authentication is already enabled");

  const secret = generateTotpSecret();
  // Pending until a code proves setup, so a half-finished enrolment can't lock them out.
  await User.updateOne(
    { _id: user._id },
    { $set: { "mfa.pendingSecret": encryptField(secret, MFA_SECRET_CONTEXT) } }
  );
  const otpauthUri = buildOtpauthUri({ secret, accountName: user.email });
  // Rendered server-side as an inline SVG data URI:
  const qrSvg = await QRCode.toString(otpauthUri, { type: "svg", margin: 1, width: 220 });
  return {
    secret,
    otpauthUri,
    qrSvg,
  };
}

export async function confirmMfaEnrollment(userId, code) {
  const user = await User.findById(userId).select(MFA_FIELDS);
  if (!user) throw publicError("User not found", 404);
  if (user.mfa?.enabled) throw publicError("Two-factor authentication is already enabled");
  if (!user.mfa?.pendingSecret) throw publicError("Start two-factor setup before confirming");

  const secret = decryptField(user.mfa.pendingSecret, MFA_SECRET_CONTEXT);
  const match = verifyTotpCode(secret, code);
  if (!match) throw publicError("That code is not valid. Check your authenticator app and try again.");

  const recoveryCodes = generateRecoveryCodes();
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        "mfa.enabled": true,
        "mfa.secret": encryptField(secret, MFA_SECRET_CONTEXT),
        "mfa.confirmedAt": new Date(),
        "mfa.lastUsedStep": match.step,
        "mfa.recoveryCodes": recoveryCodes.map((value) => ({ hash: hashRecoveryCode(value), usedAt: null })),
      },
      $unset: { "mfa.pendingSecret": 1 },
    }
  );
  // Shown to the user exactly once; only hashes are retained.
  return { recoveryCodes };
}

export async function verifyMfaChallenge(userId, code) {
  const user = await User.findById(userId).select(MFA_FIELDS);
  if (!user) throw publicError("User not found", 404);
  if (!user.mfa?.enabled || !user.mfa?.secret) throw publicError("Two-factor authentication is not enabled");
  if (!isUserActive(user)) {
    throw publicError("This account has been deactivated. Contact your administrator.", 403);
  }

  const secret = decryptField(user.mfa.secret, MFA_SECRET_CONTEXT);
  const match = verifyTotpCode(secret, code);
  if (match) {
    // Binding the last step stops a code being replayed inside its window.
    if (user.mfa.lastUsedStep !== undefined && user.mfa.lastUsedStep !== null && match.step <= user.mfa.lastUsedStep) {
      throw publicError("That code has already been used. Wait for the next one.");
    }
    await User.updateOne({ _id: user._id }, { $set: { "mfa.lastUsedStep": match.step } });
    return { user: sanitizeUser(user), method: "totp" };
  }

  const targetHash = Buffer.from(hashRecoveryCode(code));
  const index = (user.mfa.recoveryCodes || []).findIndex((entry) => {
    if (entry.usedAt) return false;
    const stored = Buffer.from(String(entry.hash || ""));
    return stored.length === targetHash.length && crypto.timingSafeEqual(stored, targetHash);
  });
  if (index === -1) throw publicError("That code is not valid.");

  await User.updateOne(
    { _id: user._id },
    { $set: { [`mfa.recoveryCodes.${index}.usedAt`]: new Date() } }
  );
  return { user: sanitizeUser(user), method: "recovery_code" };
}

export async function disableMfa(userId, { password, code } = {}) {
  const user = await User.findById(userId).select(MFA_FIELDS);
  if (!user) throw publicError("User not found", 404);
  if (!user.mfa?.enabled) throw publicError("Two-factor authentication is not enabled");
  if (isMfaRequiredForRole(user.role)) {
    throw publicError("Two-factor authentication is required for administrator accounts and cannot be turned off.");
  }
  // Re-authenticate before removing a factor so a hijacked session cannot do it.
  if (user.password) {
    if (!verifyPassword(String(password || ""), user.password)) {
      throw publicError("Current password is incorrect");
    }
  } else {
    const secret = decryptField(user.mfa.secret, MFA_SECRET_CONTEXT);
    if (!verifyTotpCode(secret, code)) throw publicError("That code is not valid.");
  }

  await User.updateOne(
    { _id: user._id },
    {
      $set: { "mfa.enabled": false },
      $unset: {
        "mfa.secret": 1,
        "mfa.pendingSecret": 1,
        "mfa.confirmedAt": 1,
        "mfa.lastUsedStep": 1,
        "mfa.recoveryCodes": 1,
      },
    }
  );
  await revokeAllTrustedDevices(userId);
  return getMfaStatus(userId);
}

export async function regenerateRecoveryCodes(userId, code) {
  const user = await User.findById(userId).select(MFA_FIELDS);
  if (!user) throw publicError("User not found", 404);
  if (!user.mfa?.enabled || !user.mfa?.secret) throw publicError("Two-factor authentication is not enabled");
  const secret = decryptField(user.mfa.secret, MFA_SECRET_CONTEXT);
  if (!verifyTotpCode(secret, code)) throw publicError("That code is not valid.");

  const recoveryCodes = generateRecoveryCodes();
  await User.updateOne(
    { _id: user._id },
    { $set: { "mfa.recoveryCodes": recoveryCodes.map((value) => ({ hash: hashRecoveryCode(value), usedAt: null })) } }
  );
  return { recoveryCodes };
}



export async function deactivateUser(targetUserId, { actorId, reason = "" } = {}) {
  const target = await User.findById(targetUserId);
  if (!target) throw publicError("User not found", 404);
  if (String(targetUserId) === String(actorId)) {
    throw publicError("You cannot deactivate your own account");
  }
  if (!isUserActive(target)) return sanitizeUser(target);

  // Last-admin guard:
  if (target.role === "admin") {
    const remainingAdmins = await User.countDocuments({
      role: "admin",
      status: { $ne: "deactivated" },
      _id: { $ne: target._id },
    });
    if (remainingAdmins === 0) throw publicError("Cannot deactivate the last active administrator");
  }

  target.status = "deactivated";
  target.deactivatedAt = new Date();
  target.deactivatedBy = actorId || undefined;
  target.deactivationReason = String(reason || "").slice(0, 500) || undefined;
  await target.save();

  // Access must stop now, not when the access token expires.
  await revokeAllSessionsForSubject(target.id);
  await revokeAllTrustedDevices(target._id);
  await disconnectUserSockets(target.id, "account_deactivated");
  // Billing is best-effort: a Stripe outage must not block revoking access.
  await setSubscriptionCancelAtPeriodEnd(target.id, true).catch((err) =>
    logError("billing.deactivate_cancel_failed", err)
  );
  return sanitizeUser(target);
}

export async function reactivateUser(targetUserId, { actorId } = {}) {
  const target = await User.findById(targetUserId);
  if (!target) throw publicError("User not found", 404);
  if (isUserActive(target)) return sanitizeUser(target);

  target.status = "active";
  target.reactivatedAt = new Date();
  target.deactivatedAt = undefined;
  target.deactivatedBy = undefined;
  target.deactivationReason = undefined;
  await target.save();
  await setSubscriptionCancelAtPeriodEnd(target.id, false).catch((err) =>
    logError("billing.reactivate_resume_failed", err)
  );
  return sanitizeUser(target);
}

export async function setUserRole(targetUserId, role, { actorId } = {}) {
  if (!["provider", "admin"].includes(role)) throw publicError("Invalid role");
  const target = await User.findById(targetUserId);
  if (!target) throw publicError("User not found", 404);
  if (String(targetUserId) === String(actorId)) {
    throw publicError("You cannot change your own role");
  }
  if (target.role === role) return sanitizeUser(target);

  if (target.role === "admin" && role === "provider") {
    const remainingAdmins = await User.countDocuments({
      role: "admin",
      status: { $ne: "deactivated" },
      _id: { $ne: target._id },
    });
    if (remainingAdmins === 0) throw publicError("Cannot demote the last active administrator");
  }

  target.role = role;
  await target.save();
  // Role is baked into the token, so sessions must be re-minted.
  await revokeAllSessionsForSubject(target.id);
  await disconnectUserSockets(target.id, "role_changed");
  return sanitizeUser(target);
}

export async function countActiveAdmins() {
  return User.countDocuments({ role: "admin", status: { $ne: "deactivated" } });
}
