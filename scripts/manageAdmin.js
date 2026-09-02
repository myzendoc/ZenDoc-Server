#!/usr/bin/env node
/**
 * Admin provisioning that requires database access rather than a network-
 * reachable credential. This is the only way to create the first admin; after
 * that, admins promote each other through the audited /api/admin routes.
 *
 *   node scripts/manageAdmin.js create  --email a@b.com --first Ada [--last L] [--password '...']
 *   node scripts/manageAdmin.js promote --email a@b.com
 *   node scripts/manageAdmin.js demote  --email a@b.com
 *   node scripts/manageAdmin.js list
 *   node scripts/manageAdmin.js reset-mfa --email a@b.com
 */
import crypto from "crypto";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { connectDatabase } from "../db.js";
import { User } from "../models/user.js";

dotenv.config();

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function generatePassword() {
  // 24 base64url chars ~= 144 bits; printed once for the operator to hand over.
  return crypto.randomBytes(18).toString("base64url");
}

async function requireUser(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) throw new Error("--email is required");
  const user = await User.findOne({ email: normalized });
  if (!user) throw new Error(`No user found for ${normalized}`);
  return user;
}

async function create(args) {
  const { hashPasswordForScript } = await import("../services/userService.js").then((m) => ({
    hashPasswordForScript: m.hashPasswordForScript,
  }));
  const email = String(args.email || "").trim().toLowerCase();
  const firstName = String(args.first || "").trim();
  if (!email || !firstName) throw new Error("--email and --first are required");

  const existing = await User.findOne({ email });
  if (existing) throw new Error(`${email} already exists; use "promote" instead`);

  const password = typeof args.password === "string" ? args.password : generatePassword();
  if (password.length < 12) throw new Error("Admin passwords must be at least 12 characters");

  const user = await User.create({
    firstName,
    lastName: String(args.last || "").trim(),
    email,
    password: hashPasswordForScript(password),
    role: "admin",
    status: "active",
    // Provisioned out-of-band, so the address is treated as already proven.
    verified: true,
    onboardingComplete: true,
  });

  console.log(`Created admin ${user.email} (${user._id})`);
  if (typeof args.password !== "string") {
    console.log(`Temporary password: ${password}`);
  }
  console.log("They must enrol in two-factor authentication before any admin route will respond.");
}

async function promote(args) {
  const user = await requireUser(args.email);
  if (user.role === "admin") {
    console.log(`${user.email} is already an admin`);
    return;
  }
  user.role = "admin";
  await user.save();
  console.log(`Promoted ${user.email} to admin. They must enrol in two-factor authentication.`);
}

async function demote(args) {
  const user = await requireUser(args.email);
  if (user.role !== "admin") {
    console.log(`${user.email} is not an admin`);
    return;
  }
  const others = await User.countDocuments({
    role: "admin",
    status: { $ne: "deactivated" },
    _id: { $ne: user._id },
  });
  if (others === 0 && !args.force) throw new Error("Refusing to demote the last active admin (pass --force to override)");
  user.role = "provider";
  await user.save();
  console.log(`Demoted ${user.email} to provider`);
}

async function resetMfa(args) {
  const user = await requireUser(args.email);
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
  console.log(`Cleared two-factor enrolment for ${user.email}. They will be prompted to enrol again.`);
}

async function list() {
  const admins = await User.find({ role: "admin" }).sort({ createdAt: 1 }).lean();
  if (!admins.length) {
    console.log("No admin accounts exist. Create one with: node scripts/manageAdmin.js create --email ... --first ...");
    return;
  }
  for (const admin of admins) {
    const state = admin.status === "deactivated" ? "deactivated" : "active";
    const mfa = admin.mfa?.enabled ? "mfa:on" : "mfa:OFF";
    console.log(`${admin.email}\t${state}\t${mfa}\t${admin._id}`);
  }
}

const COMMANDS = { create, promote, demote, list, "reset-mfa": resetMfa };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Usage: node scripts/manageAdmin.js <${Object.keys(COMMANDS).join("|")}> [--email ...]`);
    process.exitCode = 1;
    return;
  }
  await connectDatabase();
  try {
    await handler(args);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
