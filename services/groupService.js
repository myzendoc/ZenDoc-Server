import crypto from "crypto";
import { User } from "../models/user.js";
import { GroupInvite } from "../models/groupInvite.js";
import { GROUP_SEAT_LIMIT, isGroupPlanKey } from "./billingService.js";
import { sendTeamInviteEmail } from "../utils/mailer.js";

const INVITE_TTL_DAYS = 7;

function displayNameFor(user) {
  if (!user) return "User";
  const display = String(user.displayName || "").trim();
  if (display) return display;
  const full = `${user.firstName || ""} ${user.lastName || ""}`.trim();
  if (full) return full;
  const email = String(user.email || "").trim();
  return email.includes("@") ? email.split("@")[0] : email || "User";
}

function isActive(status) {
  const value = String(status || "").toLowerCase();
  return value === "active" || value === "trialing";
}

function isGroupOwner(user) {
  return Boolean(user) && isActive(user.subscriptionStatus) && isGroupPlanKey(user.subscriptionPlanKey);
}

function publicUser(user) {
  return { id: String(user._id), name: displayNameFor(user), email: user.email };
}

async function countSeatsUsed(ownerId, options = {}) {
  const inviteFilter = { ownerId, status: "pending" };
  if (options.excludeInviteId) {
    inviteFilter._id = { $ne: options.excludeInviteId };
  }
  const [memberCount, inviteCount] = await Promise.all([
    User.countDocuments({ groupOwnerId: ownerId }),
    GroupInvite.countDocuments(inviteFilter),
  ]);
  return 1 + memberCount + inviteCount;
}

export async function getGroupForUser(userId) {
  const user = await User.findById(userId);
  if (!user) return { role: "none", seatLimit: GROUP_SEAT_LIMIT };

  if (isGroupOwner(user)) {
    const [members, invites] = await Promise.all([
      User.find({ groupOwnerId: user._id }).sort({ createdAt: 1 }),
      GroupInvite.find({ ownerId: user._id, status: "pending" }).sort({ createdAt: 1 }),
    ]);
    return {
      role: "owner",
      seatLimit: GROUP_SEAT_LIMIT,
      seatsUsed: 1 + members.length + invites.length,
      owner: publicUser(user),
      members: members.map(publicUser),
      invites: invites.map((inv) => ({ id: String(inv._id), email: inv.email, invitedAt: inv.createdAt })),
    };
  }

  if (user.groupOwnerId) {
    const owner = await User.findById(user.groupOwnerId);
    if (owner && isGroupOwner(owner)) {
      return { role: "member", seatLimit: GROUP_SEAT_LIMIT, owner: publicUser(owner) };
    }
    return { role: "none", seatLimit: GROUP_SEAT_LIMIT };
  }

  return { role: "none", seatLimit: GROUP_SEAT_LIMIT };
}

export async function inviteMember(ownerUserId, rawEmail, clientBaseUrl) {
  const owner = await User.findById(ownerUserId);
  if (!isGroupOwner(owner)) throw new Error("Start a team plan before inviting members");

  const email = String(rawEmail || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address");
  if (email === String(owner.email).toLowerCase()) throw new Error("You are already on this team");

  const existingMember = await User.findOne({ email, groupOwnerId: owner._id });
  if (existingMember) throw new Error("That person is already on your team");

  const existingUser = await User.findOne({ email });
  if (existingUser?.groupOwnerId) throw new Error("That person is already on another team");
  if (isGroupOwner(existingUser)) throw new Error("That person already manages their own team");

  const existingInvite = await GroupInvite.findOne({ ownerId: owner._id, email, status: "pending" });
  if (existingInvite) throw new Error("An invitation is already pending for that email");

  const seatsUsed = await countSeatsUsed(owner._id);
  if (seatsUsed >= GROUP_SEAT_LIMIT) throw new Error(`Your team is full (max ${GROUP_SEAT_LIMIT} members)`);

  const token = crypto.randomBytes(24).toString("hex");
  const invite = await GroupInvite.create({
    ownerId: owner._id,
    email,
    token,
    status: "pending",
    invitedByName: displayNameFor(owner),
    expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
  });

  const base = String(clientBaseUrl || process.env.CLIENT_APP_URL || "http://localhost:5173").replace(/\/$/, "");
  const joinLink = `${base}/join-team?token=${encodeURIComponent(token)}`;
  await sendTeamInviteEmail({ email, inviterName: displayNameFor(owner), joinLink });

  return { id: String(invite._id), email: invite.email, invitedAt: invite.createdAt };
}

export async function getInviteByToken(token) {
  const invite = await GroupInvite.findOne({ token: String(token || "") });
  if (!invite) return null;
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return null;
  const owner = await User.findById(invite.ownerId);
  return {
    email: invite.email,
    inviterName: invite.invitedByName || displayNameFor(owner),
    status: invite.status,
    valid: Boolean(invite.status === "pending" && owner && isGroupOwner(owner)),
  };
}

export async function acceptInvite(token, userId) {
  const invite = await GroupInvite.findOne({ token: String(token || "") });
  if (!invite) throw new Error("This invitation is invalid or has expired");
  if (invite.status === "revoked") throw new Error("This invitation has been revoked");
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) throw new Error("This invitation has expired");

  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  if (String(user.email).toLowerCase() !== invite.email) {
    throw new Error("This invitation was sent to a different email address");
  }
  if (isGroupOwner(user)) throw new Error("You already manage your own team");
  if (user.groupOwnerId && String(user.groupOwnerId) !== String(invite.ownerId)) {
    throw new Error("You are already on another team");
  }

  const owner = await User.findById(invite.ownerId);
  if (!owner || !isGroupOwner(owner)) throw new Error("This team is no longer active");

  if (invite.status === "accepted") {
    if (String(user.groupOwnerId || "") === String(invite.ownerId)) {
      return { owner: publicUser(owner), alreadyAccepted: true };
    }
    throw new Error("This invitation has already been accepted");
  }

  if (!user.groupOwnerId) {
    const seatsUsed = await countSeatsUsed(owner._id, { excludeInviteId: invite._id });
    if (seatsUsed >= GROUP_SEAT_LIMIT) throw new Error("This team is full");
    user.groupOwnerId = owner._id;
    await user.save();
  }

  invite.status = "accepted";
  await invite.save();

  return { owner: publicUser(owner) };
}

export async function removeMember(ownerUserId, memberUserId) {
  const owner = await User.findById(ownerUserId);
  if (!isGroupOwner(owner)) throw new Error("You do not manage a team");
  const member = await User.findById(memberUserId);
  if (!member || String(member.groupOwnerId || "") !== String(owner._id)) {
    throw new Error("That member is not on your team");
  }
  member.groupOwnerId = undefined;
  await member.save();
  return { removed: String(member._id) };
}

export async function revokeInvite(ownerUserId, inviteId) {
  const owner = await User.findById(ownerUserId);
  if (!isGroupOwner(owner)) throw new Error("You do not manage a team");
  const invite = await GroupInvite.findOne({ _id: inviteId, ownerId: owner._id, status: "pending" });
  if (!invite) throw new Error("Invitation not found");
  invite.status = "revoked";
  await invite.save();
  return { revoked: String(invite._id) };
}

export async function leaveGroup(userId) {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  if (!user.groupOwnerId) throw new Error("You are not on a team");
  user.groupOwnerId = undefined;
  await user.save();
  return { left: true };
}
