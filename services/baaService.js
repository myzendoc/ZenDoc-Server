import { User } from "../models/user.js";
import { sanitizeUser } from "./userService.js";
import { createAuditLog } from "./auditLogService.js";
import { generateBaaPdf, BAA_DOCUMENT_VERSION } from "../utils/baaPdf.js";
import { sendBaaEmail } from "../utils/mailer.js";
import { publicError } from "../utils/errors.js";
import { logError } from "../utils/logging.js";

function coerce(value) {
  return String(value ?? "").trim();
}

/**
 * Persist a Covered Entity's signed BAA on their user record.
 * Captures the signature but does NOT email — emailing happens via
 * maybeSendBaaEmail once the account is verified.
 */
export async function recordBaaSignature(userId, fields = {}, context = {}) {
  if (!userId) throw new Error("Missing user");
  const organization = coerce(fields.organization);
  const signatoryName = coerce(fields.signatoryName);
  const signatoryTitle = coerce(fields.signatoryTitle);
  const signature = coerce(fields.signature) || signatoryName;
  if (!organization || !signatoryName || !signatoryTitle || !signature) {
    throw publicError("Organization, signatory name, signatory title and signature are required to sign the BAA");
  }

  const signedAt = new Date();
  const user = await User.findByIdAndUpdate(
    userId,
    {
      $set: {
        baa: {
          signed: true,
          organization,
          signatoryName,
          signatoryTitle,
          signature,
          signedAt,
          effectiveDate: signedAt,
          documentVersion: BAA_DOCUMENT_VERSION,
          ipAddress: coerce(context.ipAddress) || undefined,
          emailedAt: undefined,
        },
      },
    },
    { new: true }
  );
  if (!user) throw new Error("User not found");

  await createAuditLog({
    actorUserId: userId,
    actorRole: user.role,
    actorEmail: user.email,
    actorName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
    action: "baa.signed",
    resourceType: "baa",
    resourceId: userId,
    ipAddress: coerce(context.ipAddress),
    country: coerce(context.country),
    userAgent: coerce(context.userAgent),
    metadata: { documentVersion: BAA_DOCUMENT_VERSION },
  }).catch((err) => logError("audit.baa_signed_write_failed", err));

  return sanitizeUser(user);
}

/**
 * Email the signed BAA PDF to the provider, but only once: the account must
 * be verified, a BAA must be on file, and it must not have been emailed yet.
 * Idempotent and safe to call from signup/verify/setup flows.
 * @returns {Promise<boolean>} whether an email was sent
 */
export async function maybeSendBaaEmail(userId, context = {}) {
  if (!userId) return false;
  const user = await User.findById(userId);
  if (!user) return false;
  if (!user.verified) return false;
  if (!user.baa?.signed) return false;
  if (user.baa.emailedAt) return false;

  const pdfBuffer = await generateBaaPdf({
    organization: user.baa.organization,
    signatoryName: user.baa.signatoryName,
    signatoryTitle: user.baa.signatoryTitle,
    signature: user.baa.signature,
    signedAt: user.baa.signedAt,
    effectiveDate: user.baa.effectiveDate,
  });

  await sendBaaEmail({ email: user.email, pdfBuffer, signatoryName: user.baa.signatoryName });

  user.baa.emailedAt = new Date();
  await user.save();

  await createAuditLog({
    actorUserId: userId,
    actorRole: user.role,
    actorEmail: user.email,
    actorName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
    action: "baa.emailed",
    resourceType: "baa",
    resourceId: userId,
    ipAddress: coerce(context.ipAddress),
    country: coerce(context.country),
    metadata: { documentVersion: user.baa.documentVersion },
  }).catch((err) => logError("audit.baa_emailed_write_failed", err));

  return true;
}
