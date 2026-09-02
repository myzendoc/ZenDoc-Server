import {
  createBreakGlassGrant,
  listBreakGlassGrants,
  readRecordsUnderGrant,
  revokeBreakGlassGrant,
} from "../services/breakGlassService.js";
import { getIpFromRequest } from "../utils/audit.js";
import { sendErrorResponse } from "../utils/errors.js";

export async function openBreakGlass(req, res) {
  try {
    const grant = await createBreakGlassGrant({
      actor: req.user,
      targetUserId: req.body?.targetUserId,
      reason: req.body?.reason,
      code: req.body?.code,
      ipAddress: getIpFromRequest(req),
    });
    res.json({
      grant,
      message: `Emergency access opened for ${grant.targetEmail}. ${grant.notifiedAdminCount} administrator(s) notified.`,
    });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to open emergency access", status: 400, event: "breakglass.open_failed" });
  }
}

export async function listBreakGlass(req, res) {
  try {
    res.json({ grants: await listBreakGlassGrants({ limit: Number(req.query?.limit) || 50 }) });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to list emergency access", status: 500, event: "breakglass.list_failed" });
  }
}

export async function getBreakGlassRecords(req, res) {
  try {
    res.json(await readRecordsUnderGrant(req.params.grantId, req.user?._id));
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to read records", status: 400, event: "breakglass.read_failed" });
  }
}

export async function closeBreakGlass(req, res) {
  try {
    const grant = await revokeBreakGlassGrant(req.params.grantId, req.user?._id);
    res.json({ grant, message: "Emergency access revoked" });
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to revoke emergency access", status: 400, event: "breakglass.revoke_failed" });
  }
}
