import crypto from "crypto";
import { User } from "../models/user.js";
import { signToken } from "../utils/jwt.js";
import { Meeting } from "../models/meeting.js";

const ITERATIONS = 120000;

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

export function sanitizeUser(user) {
  if (!user) return null;
  const obj = user.toObject ? user.toObject() : user;
  delete obj.password;
  return obj;
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
    onboardingComplete: true,
  });
  const token = signToken({ sub: user.id, role: user.role }, process.env.JWT_SECRET);
  return { user: sanitizeUser(user), token };
}

export async function authenticateUser(email, password) {
  if (!email || !password) throw new Error("Missing credentials");
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new Error("Invalid credentials");
  const valid = verifyPassword(password, user.password);
  if (!valid) throw new Error("Invalid credentials");
  const token = signToken({ sub: user.id, role: user.role }, process.env.JWT_SECRET);
  return { user: sanitizeUser(user), token };
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
  if (Object.keys(updates).length === 0) return getUserById(userId);
  if (updates.firstName) updates.onboardingComplete = true;
  const user = await User.findByIdAndUpdate(userId, { $set: updates }, { new: true });
  return sanitizeUser(user);
}

export async function listUsersWithMeetingCounts() {
  const users = await User.find({}).sort({ createdAt: -1 }).lean();
  const meetingCounts = await Meeting.aggregate([
    { $match: { createdBy: { $exists: true } } },
    {
      $group: {
        _id: "$createdBy",
        count: { $sum: 1 },
        lastMeetingAt: { $max: "$createdAt" },
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
    };
  });
}
