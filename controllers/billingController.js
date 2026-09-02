import {
  createCheckoutSessionForUser,
  createPortalSessionForUser,
  getBillingStatusForUser,
  getPlanCatalog,
  processStripeWebhook,
} from "../services/billingService.js";
import { getUserById } from "../services/userService.js";
import { sendErrorResponse } from "../utils/errors.js";
import { logError } from "../utils/logging.js";

export async function listBillingPlans(req, res) {
  try {
    res.json({ plans: getPlanCatalog() });
  } catch {
    res.status(500).json({ error: "Failed to fetch plans" });
  }
}

export async function createCheckoutSession(req, res) {
  try {
    const planKey = String(req.body?.planKey || "").trim();
    const user = await getUserById(req.user?._id);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const result = await createCheckoutSessionForUser({ user, planKey });
    res.json(result);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to create checkout session", status: 400, event: "billing.checkout_failed" });
  }
}

export async function stripeWebhook(req, res) {
  try {
    const signature = req.headers["stripe-signature"];
    const rawBody = req.body;
    const result = await processStripeWebhook({ rawBody, signature });
    res.json(result);
  } catch (err) {
    logError("billing.webhook_failed", err, {
      hasSignature: Boolean(req.headers["stripe-signature"]),
      bodyType: Buffer.isBuffer(req.body) ? "buffer" : typeof req.body,
    });
    res.status(400).json({ error: "Invalid webhook" });
  }
}

export async function getBillingStatus(req, res) {
  try {
    const status = await getBillingStatusForUser(req.user?._id);
    if (!status) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(status);
  } catch {
    res.status(500).json({ error: "Failed to fetch billing status" });
  }
}

export async function createPortalSession(req, res) {
  try {
    const user = await getUserById(req.user?._id);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const session = await createPortalSessionForUser(user);
    res.json(session);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to create portal session", status: 400, event: "billing.portal_failed" });
  }
}
