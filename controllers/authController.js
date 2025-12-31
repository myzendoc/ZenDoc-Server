import { authenticateUser, createUser, updateUserProfile } from "../services/userService.js";

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
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to sign up" });
  }
}

export async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    const result = await authenticateUser(email, password);
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
