import crypto from "crypto";
import { User } from "../models/user.js";
import { signToken } from "../utils/jwt.js";
import { Meeting } from "../models/meeting.js";
import { MeetingSession } from "../models/meetingSession.js";

const ITERATIONS = 120000;
const OTP_TTL_MINUTES = 10;
const RESET_PASSWORD_TTL_MINUTES = 30;
const ENV_ADMIN_SUB = "env-admin";

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.pbkdf2Sync(password, salt, ITERATIONS, 64, "sha512").toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  if (!password || !stored) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = crypto.pbkdf2Sync(password, salt, ITERATIONS, 64, "sha512").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(derived));
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
  const obj = user.toObject ? user.toObject() : user;
  delete obj.password;
  delete obj.otpCode;
  delete obj.otpExpires;
  delete obj.emailChangeOtp;
  delete obj.emailChangeOtpExpires;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpires;
  obj.hasPassword = Boolean(user.password);
  return obj;
}

function getAdminTokenSecret() {
  return process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
}

function getEnvAdminIdentity() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) return null;
  return {
    _id: ENV_ADMIN_SUB,
    id: ENV_ADMIN_SUB,
    firstName: process.env.ADMIN_FIRST_NAME || "Admin",
    lastName: process.env.ADMIN_LAST_NAME || "",
    email,
    role: "admin",
    onboardingComplete: true,
    verified: true,
  };
}

export function getEnvAdminUserFromPayload(payload) {
  if (!payload || payload.sub !== ENV_ADMIN_SUB || payload.role !== "admin") return null;
  const admin = getEnvAdminIdentity();
  if (!admin) return null;
  if (payload.email && payload.email.toLowerCase() !== admin.email) return null;
  return sanitizeUser(admin);
}

export async function createUser({ firstName, lastName, email, password, role = "provider" }) {
  if (!firstName || !email || !password) throw new Error("Missing required fields");
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw new Error("User already exists");
  const hashed = hashPassword(password);
  const user = await User.create({
    firstName,
    lastName,
    email: email.toLowerCase(),
    password: hashed,
    role,
    onboardingComplete: false,
    verified: false,
  });
  const token = signToken({ sub: user.id, role: user.role }, process.env.JWT_SECRET);
  return { user: sanitizeUser(user), token };
}

export async function authenticateUser(email, password) {
  if (!email || !password) throw new Error("Missing credentials");
  const admin = getEnvAdminIdentity();
  const inputEmail = email.toLowerCase();
  if (admin && inputEmail === admin.email && password === process.env.ADMIN_PASSWORD) {
    const token = signToken(
      { sub: ENV_ADMIN_SUB, role: "admin", email: admin.email, typ: "admin" },
      getAdminTokenSecret()
    );
    return { user: sanitizeUser(admin), token };
  }
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new Error("Invalid credentials");
  if (!user.password) throw new Error("Use Google sign-in for this account");
  const valid = verifyPassword(password, user.password);
  if (!valid) throw new Error("Invalid credentials");
  const token = signToken({ sub: user.id, role: user.role }, process.env.JWT_SECRET);
  return { user: sanitizeUser(user), token };
}

export async function authenticateGoogleUser({ googleId, email, firstName, lastName }) {
  const normalizedEmail = String(email || "").toLowerCase().trim();
  if (!googleId || !normalizedEmail) throw new Error("Missing Google profile");

  let user = await User.findOne({ googleId });
  if (!user) {
    user = await User.findOne({ email: normalizedEmail });
  }

  if (user) {
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
    });
  }

  const token = signToken({ sub: user.id, role: user.role }, process.env.JWT_SECRET);
  return { user: sanitizeUser(user), token };
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
  if (!user.otpCode || !user.otpExpires) return null;
  if (user.otpExpires.getTime() < Date.now()) return null;
  const matches = user.otpCode === hashOtp(code);
  if (!matches) return null;
  user.verified = true;
  user.otpCode = undefined;
  user.otpExpires = undefined;
  await user.save();
  const token = signToken({ sub: user.id, role: user.role }, process.env.JWT_SECRET);
  return { user: sanitizeUser(user), token };
}

export async function issuePasswordResetForEmail(email) {
  if (!email) return null;
  const user = await User.findOne({ email: String(email).toLowerCase() });
  if (!user) return null;
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
  if (!user) return null;
  user.password = hashPassword(passwordInput);
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
  await user.save();
  return sanitizeUser(user);
}

export async function changePassword(userId, currentPassword, newPassword) {
  if (!userId) throw new Error("Missing user");
  const next = String(newPassword || "");
  if (next.length < 8) throw new Error("New password must be at least 8 characters");
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  // Users who signed up with Google have no password yet and may set one without a current password.
  if (user.password) {
    if (!verifyPassword(String(currentPassword || ""), user.password)) {
      throw new Error("Current password is incorrect");
    }
  }
  user.password = hashPassword(next);
  await user.save();
  return sanitizeUser(user);
}

export async function requestEmailChange(userId, newEmail, currentPassword) {
  if (!userId) throw new Error("Missing user");
  const normalized = String(newEmail || "").toLowerCase().trim();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Enter a valid email address");
  }
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  if (normalized === user.email) throw new Error("That is already your email address");
  if (user.password) {
    if (!verifyPassword(String(currentPassword || ""), user.password)) {
      throw new Error("Current password is incorrect");
    }
  }
  const existing = await User.findOne({ email: normalized });
  if (existing) throw new Error("That email address is already in use");
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
    throw new Error("That email address is already in use");
  }
  user.email = user.pendingEmail;
  user.verified = true;
  user.pendingEmail = undefined;
  user.emailChangeOtp = undefined;
  user.emailChangeOtpExpires = undefined;
  await user.save();
  return sanitizeUser(user);
}

export async function disconnectGoogle(userId) {
  if (!userId) throw new Error("Missing user");
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  if (!user.googleId) throw new Error("Google is not connected to this account");
  if (!user.password) {
    throw new Error("Set a password before disconnecting Google so you can still sign in");
  }
  user.googleId = undefined;
  user.authProvider = "local";
  await user.save();
  return sanitizeUser(user);
}
