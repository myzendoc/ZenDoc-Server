import {
  getGroupForUser,
  inviteMember,
  acceptInvite,
  removeMember,
  revokeInvite,
  leaveGroup,
  getInviteByToken,
} from "../services/groupService.js";

function getClientBaseUrl(req) {
  const envBase = String(process.env.CLIENT_APP_URL || "").trim().replace(/\/$/, "");
  if (envBase) return envBase;
  const origin = String(req.headers?.origin || "").trim().replace(/\/$/, "");
  if (origin) return origin;
  return `${req.protocol}://${req.get("host")}`;
}

export async function getGroup(req, res) {
  try {
    const group = await getGroupForUser(req.user?._id);
    res.json(group);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to load team" });
  }
}

export async function postInvite(req, res) {
  try {
    const invite = await inviteMember(req.user?._id, req.body?.email, getClientBaseUrl(req));
    res.json({ invite });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to send invitation" });
  }
}

export async function lookupInvite(req, res) {
  try {
    const invite = await getInviteByToken(req.params?.token);
    if (!invite) {
      res.status(404).json({ error: "Invitation not found or expired" });
      return;
    }
    res.json(invite);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to load invitation" });
  }
}

export async function postAcceptInvite(req, res) {
  try {
    const result = await acceptInvite(req.body?.token, req.user?._id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to accept invitation" });
  }
}

export async function deleteMember(req, res) {
  try {
    const result = await removeMember(req.user?._id, req.params?.userId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to remove member" });
  }
}

export async function deleteInvite(req, res) {
  try {
    const result = await revokeInvite(req.user?._id, req.params?.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to revoke invitation" });
  }
}

export async function postLeave(req, res) {
  try {
    const result = await leaveGroup(req.user?._id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to leave team" });
  }
}
