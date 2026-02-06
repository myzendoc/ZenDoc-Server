import { authenticateUser, createUser, issueOtpForUser, updateUserProfile, verifyOtpForUser, findUserByEmail } from "../services/userService.js";
import { sendOtpEmail } from "../utils/mailer.js";

function resolveRole(adminCode) {
  if (adminCode && process.env.ADMIN_INVITE_CODE && adminCode === process.env.ADMIN_INVITE_CODE) {
    return "admin";
  }
  return "provider";
}

export async function signup(req, res) {
  try {
    const { firstName, lastName, email, password, adminCode } = req.body || {};
    const role = resolveRole(adminCode);
    const result = await createUser({ firstName, lastName, email, password, role });
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
    const user = await updateUserProfile(req.user?._id, req.body || {});
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: "Failed to update profile" });
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
    res.json(verified);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to verify OTP" });
  }
}
