import {
  createCheckoutSessionForUser,
  createPortalSessionForUser,
  getBillingStatusForUser,
  getPlanCatalog,
  processStripeWebhook,
} from "../services/billingService.js";
import { getUserById } from "../services/userService.js";

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
    res.status(400).json({ error: err.message || "Failed to create checkout session" });
  }
}

export async function stripeWebhook(req, res) {
  try {
    const signature = req.headers["stripe-signature"];
    const rawBody = req.body;
    const result = await processStripeWebhook({ rawBody, signature });
    res.json(result);
  } catch (err) {
    console.error("stripe webhook error", {
      message: err?.message || err,
      hasSignature: Boolean(req.headers["stripe-signature"]),
      contentType: req.headers["content-type"],
      bodyType: Buffer.isBuffer(req.body) ? "buffer" : typeof req.body,
    });
    res.status(400).json({ error: err.message || "Invalid webhook" });
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
    res.status(400).json({ error: err.message || "Failed to create portal session" });
  }
}
