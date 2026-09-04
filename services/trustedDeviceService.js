import crypto from "crypto";
import mongoose from "mongoose";
import { TrustedDevice } from "../models/trustedDevice.js";

export function getTrustedDeviceDays() {
  const value = Number(process.env.TRUSTED_DEVICE_DAYS);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function labelFromUserAgent(userAgent = "") {
  const ua = String(userAgent || "");
  const os = /Windows/i.test(ua) ? "Windows" : /Mac OS X|Macintosh/i.test(ua) ? "macOS"
    : /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS"
    : /Linux/i.test(ua) ? "Linux" : "Unknown device";
  const browser = /Edg\//i.test(ua) ? "Edge" : /Chrome\//i.test(ua) ? "Chrome"
    : /Safari\//i.test(ua) ? "Safari" : /Firefox\//i.test(ua) ? "Firefox" : "browser";
  return `${browser} on ${os}`;
}

export async function issueTrustedDevice(userId, { userAgent, ipAddress } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + getTrustedDeviceDays() * 24 * 60 * 60 * 1000);
  const device = await TrustedDevice.create({
    userId,
    tokenHash: hashToken(token),
    label: labelFromUserAgent(userAgent),
    userAgent: String(userAgent || "").slice(0, 300),
    ipAddress,
    lastUsedAt: new Date(),
    expiresAt,
  });
  // The raw token goes to the cookie; only its hash is stored.
  return { token: `${device._id}.${token}`, expiresAt, device };
}

// Returns the device only if the token matches AND belongs to this user.
export async function findValidTrustedDevice(rawValue, userId) {
  const value = String(rawValue || "");
  const separator = value.indexOf(".");
  if (separator < 1) return null;
  const deviceId = value.slice(0, separator);
  const token = value.slice(separator + 1);
  if (!mongoose.Types.ObjectId.isValid(deviceId)) return null;

  const device = await TrustedDevice.findById(deviceId).select("+tokenHash");
  if (!device || device.revokedAt) return null;
  if (String(device.userId) !== String(userId)) return null;
  if (new Date(device.expiresAt).getTime() <= Date.now()) return null;

  const expected = Buffer.from(device.tokenHash);
  const actual = Buffer.from(hashToken(token));
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

  device.lastUsedAt = new Date();
  await device.save();
  return device;
}

export async function listTrustedDevices(userId) {
  const devices = await TrustedDevice.find({ userId, revokedAt: null })
    .sort({ lastUsedAt: -1 })
    .lean();
  return devices.map((device) => ({
    id: String(device._id),
    label: device.label || "Unknown device",
    lastUsedAt: device.lastUsedAt || device.createdAt,
    expiresAt: device.expiresAt,
  }));
}

export async function revokeTrustedDevice(userId, deviceId) {
  if (!mongoose.Types.ObjectId.isValid(String(deviceId))) return 0;
  const result = await TrustedDevice.updateOne(
    { _id: deviceId, userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  return result.modifiedCount || 0;
}

// Called whenever credentials or MFA change, and on deactivation.
export async function revokeAllTrustedDevices(userId) {
  if (!userId) return 0;
  const result = await TrustedDevice.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  return result.modifiedCount || 0;
}
