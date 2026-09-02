import {
  getGroupForUser,
  inviteMember,
  acceptInvite,
  removeMember,
  revokeInvite,
  leaveGroup,
  getInviteByToken,
  deactivateMember,
  reactivateMember,
} from "../services/groupService.js";
import { sendErrorResponse } from "../utils/errors.js";

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
    sendErrorResponse(res, err, { fallback: "Failed to load team", status: 400, event: "group.load_failed" });
  }
}

export async function postInvite(req, res) {
  try {
    const invite = await inviteMember(req.user?._id, req.body?.email, getClientBaseUrl(req));
    res.json({ invite });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to send invitation", status: 400, event: "group.invite_failed" });
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
    sendErrorResponse(res, err, { fallback: "Failed to load invitation", status: 400, event: "group.invite_lookup_failed" });
  }
}

export async function postAcceptInvite(req, res) {
  try {
    const result = await acceptInvite(req.body?.token, req.user?._id);
    res.json(result);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to accept invitation", status: 400, event: "group.invite_accept_failed" });
  }
}

export async function deleteMember(req, res) {
  try {
    const result = await removeMember(req.user?._id, req.params?.userId);
    res.json(result);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to remove member", status: 400, event: "group.member_remove_failed" });
  }
}

export async function postDeactivateMember(req, res) {
  try {
    const result = await deactivateMember(req.user?._id, req.params?.userId, req.body?.reason);
    res.json(result);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to deactivate member", status: 400, event: "group.member_deactivate_failed" });
  }
}

export async function postReactivateMember(req, res) {
  try {
    const result = await reactivateMember(req.user?._id, req.params?.userId);
    res.json(result);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to reactivate member", status: 400, event: "group.member_reactivate_failed" });
  }
}

export async function deleteInvite(req, res) {
  try {
    const result = await revokeInvite(req.user?._id, req.params?.id);
    res.json(result);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to revoke invitation", status: 400, event: "group.invite_revoke_failed" });
  }
}

export async function postLeave(req, res) {
  try {
    const result = await leaveGroup(req.user?._id);
    res.json(result);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to leave team", status: 400, event: "group.leave_failed" });
  }
}
