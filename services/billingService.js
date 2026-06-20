import Stripe from "stripe";
import { User } from "../models/user.js";

export const GROUP_SEAT_LIMIT = 10;

const PLAN_DEFS = [
  {
    key: "free",
    name: "Free Plan",
    amount: 0,
    currency: "usd",
    interval: "month",
    cadenceLabel: "/ month",
    priceEnv: "",
    features: [
      "Unlimited Video-Audio calls + Live chats",
      "3 Automated Clinical (SOAP) notes",
      "Waiting room",
      "BAA available",
    ],
  },
  {
    key: "premium_weekly",
    name: "Premium Weekly",
    amount: 900,
    currency: "usd",
    interval: "week",
    cadenceLabel: "/ week",
    priceEnv: "STRIPE_PRICE_PREMIUM_WEEKLY",
    features: [
      "Unlimited Video-Audio calls + Live chats",
      "Unlimited Automated Clinical (SOAP) Notes",
      "Waiting room",
      "Screen sharing",
      "Unlimited real-time meeting transcripts (saved to your dashboard)",
      "BAA available",
    ],
  },
  {
    key: "premium_monthly",
    name: "Premium Plan",
    amount: 1900,
    currency: "usd",
    interval: "month",
    cadenceLabel: "/ month",
    priceEnv: "STRIPE_PRICE_PREMIUM_MONTHLY",
    features: [
      "Unlimited Video-Audio calls + Live chats",
      "Unlimited Automated Clinical (SOAP) Notes",
      "Waiting room",
      "Screen Sharing",
      "Unlimited real-time meeting transcripts (saved to your dashboard)",
      "BAA available",
    ],
  },
  {
    key: "premium_yearly",
    name: "Premium Plan",
    amount: 19900,
    currency: "usd",
    interval: "year",
    cadenceLabel: "/ year",
    priceEnv: "STRIPE_PRICE_PREMIUM_YEARLY",
    features: [
      "Unlimited Video-Audio calls + Live chats",
      "Unlimited Automated Clinical (SOAP) Notes",
      "Waiting room",
      "Screen Sharing",
      "Unlimited real-time meeting transcripts (saved to your dashboard)",
      "BAA available",
    ],
  },
  {
    key: "premium_group_monthly",
    aliases: ["group"],
    name: "Group Plan",
    amount: 17900,
    currency: "usd",
    interval: "month",
    cadenceLabel: "/ month",
    priceEnv: "STRIPE_PRICE_PREMIUM_GROUP_MONTHLY",
    seatLimit: GROUP_SEAT_LIMIT,
    features: [
      "Everything in Premium",
      `Up to ${GROUP_SEAT_LIMIT} team members`,
      "Invite and manage your team",
      "Unlimited Automated Clinical (SOAP) Notes",
      "Unlimited real-time meeting transcripts",
      "BAA available",
    ],
  },
  {
    key: "premium_group_yearly",
    name: "Group Plan",
    amount: 159900,
    currency: "usd",
    interval: "year",
    cadenceLabel: "/ year",
    priceEnv: "STRIPE_PRICE_PREMIUM_GROUP_YEARLY",
    seatLimit: GROUP_SEAT_LIMIT,
    features: [
      "Everything in Premium",
      `Up to ${GROUP_SEAT_LIMIT} team members`,
      "Invite and manage your team",
      "Unlimited Automated Clinical (SOAP) Notes",
      "Unlimited real-time meeting transcripts",
      "BAA available",
    ],
  },
];

function getStripeClient() {
  const key = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) throw new Error("STRIPE_SECRET_KEY missing");
  return new Stripe(key);
}

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function getClientAppUrl() {
  return String(process.env.CLIENT_APP_URL || "").trim().replace(/\/$/, "") || "http://localhost:5173";
}

export function getPlanCatalog() {
  return PLAN_DEFS.map((plan) => ({
    key: plan.key,
    name: plan.name,
    amount: plan.amount,
    currency: plan.currency,
    interval: plan.interval,
    cadenceLabel: plan.cadenceLabel,
    seatLimit: plan.seatLimit || 1,
    features: plan.features,
  }));
}

function getPlanDef(planKey) {
  const key = String(planKey || "").trim();
  return PLAN_DEFS.find((item) => item.key === key || item.aliases?.includes(key)) || null;
}

export function isGroupPlanKey(planKey = "") {
  const key = String(planKey || "").trim();
  const planDef = getPlanDef(key);
  return Boolean(planDef?.seatLimit);
}

async function resolvePriceIdForPlan(stripe, planDef) {
  const envKey = planDef?.priceEnv;
  const raw = envKey ? String(process.env[envKey] || "").trim() : "";
  if (!raw) {
    throw new Error(`Missing ${envKey}`);
  }

  if (raw.startsWith("price_")) {
    return raw;
  }

  if (!raw.startsWith("prod_")) {
    throw new Error(`Invalid Stripe plan identifier in ${envKey}. Expected price_ or prod_.`);
  }

  const prices = await stripe.prices.list({ product: raw, active: true, limit: 100 });
  const matched = prices.data.find(
    (price) =>
      price.type === "recurring" &&
      price.recurring?.interval === planDef.interval &&
      (price.unit_amount || 0) > 0
  );

  if (!matched?.id) {
    throw new Error(`No active recurring ${planDef.interval} price found for product ${raw}`);
  }

  return matched.id;
}

export async function ensureStripeCustomerForUser(user) {
  if (!user?._id) throw new Error("User missing");
  const stripe = getStripeClient();
  const email = normalizeEmail(user.email);

  if (user.stripeCustomerId) {
    return { stripe, customerId: user.stripeCustomerId };
  }

  const customer = await stripe.customers.create({
    email,
    metadata: { userId: String(user._id) },
  });

  await User.findByIdAndUpdate(user._id, { $set: { stripeCustomerId: customer.id } });
  return { stripe, customerId: customer.id };
}

export async function createCheckoutSessionForUser({ user, planKey }) {
  const planDef = getPlanDef(planKey);
  if (!planDef) throw new Error("Invalid plan");
  if (planDef.key === "free") throw new Error("Free plan does not require checkout");

  const { stripe, customerId } = await ensureStripeCustomerForUser(user);
  const priceId = await resolvePriceIdForPlan(stripe, planDef);
  const appUrl = getClientAppUrl();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/upgrade?canceled=1`,
    allow_promotion_codes: true,
    metadata: {
      userId: String(user._id),
      planKey: planDef.key,
    },
    subscription_data: {
      metadata: {
        userId: String(user._id),
        planKey: planDef.key,
      },
    },
  });

  return {
    checkoutUrl: session.url,
    sessionId: session.id,
  };
}

function mapStripeIntervalToPlanKey(interval = "") {
  if (interval === "week") return "premium_weekly";
  if (interval === "year") return "premium_yearly";
  if (interval === "month") return "premium_monthly";
  return "free";
}

function mapStripePriceToPlanKey(priceId = "") {
  const id = String(priceId || "").trim();
  if (!id) return "";
  const planDef = PLAN_DEFS.find((plan) => {
    const envKey = plan.priceEnv;
    if (!envKey) return false;
    return String(process.env[envKey] || "").trim() === id;
  });
  return planDef?.key || "";
}

async function updateUserFromSubscription(subscription, fallbackUserId = "") {
  const customerId = String(subscription?.customer || "").trim();
  if (!customerId) return null;

  let user = await User.findOne({ stripeCustomerId: customerId });
  if (!user && fallbackUserId) {
    user = await User.findById(fallbackUserId);
  }
  if (!user) return null;

  const primaryItem = subscription?.items?.data?.[0];
  const interval = primaryItem?.price?.recurring?.interval || "";
  const metaPlanKey = String(subscription?.metadata?.planKey || "").trim();
  const metaPlanDef = getPlanDef(metaPlanKey);
  const pricePlanKey = mapStripePriceToPlanKey(primaryItem?.price?.id);
  const planKey = metaPlanDef?.key || pricePlanKey || mapStripeIntervalToPlanKey(interval);
  const periodEndSec = Number(subscription?.current_period_end || 0);

  user.stripeCustomerId = customerId || user.stripeCustomerId;
  user.stripeSubscriptionId = String(subscription?.id || user.stripeSubscriptionId || "");
  user.stripePriceId = String(primaryItem?.price?.id || "");
  user.subscriptionPlanKey = planKey;
  user.subscriptionStatus = String(subscription?.status || "inactive");
  user.subscriptionCurrentPeriodEnd = periodEndSec ? new Date(periodEndSec * 1000) : null;
  user.subscriptionCancelAtPeriodEnd = Boolean(subscription?.cancel_at_period_end);
  await user.save();
  return user;
}

async function setInactiveSubscriptionByCustomer(customerId = "") {
  if (!customerId) return;
  await User.findOneAndUpdate(
    { stripeCustomerId: customerId },
    {
      $set: {
        subscriptionPlanKey: "free",
        subscriptionStatus: "inactive",
        stripeSubscriptionId: null,
        stripePriceId: null,
        subscriptionCurrentPeriodEnd: null,
        subscriptionCancelAtPeriodEnd: false,
      },
    }
  );
}

export async function processStripeWebhook({ rawBody, signature }) {
  const stripe = getStripeClient();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET missing");
  }

  const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode === "subscription" && session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(String(session.subscription), {
          expand: ["items.data.price"],
        });
        const fallbackUserId = String(session?.metadata?.userId || "");
        await updateUserFromSubscription(subscription, fallbackUserId);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subscription = event.data.object;
      await updateUserFromSubscription(subscription);
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      await setInactiveSubscriptionByCustomer(String(subscription?.customer || ""));
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const customerId = String(invoice?.customer || "");
      if (customerId) {
        await User.findOneAndUpdate(
          { stripeCustomerId: customerId },
          { $set: { subscriptionStatus: "past_due" } }
        );
      }
      break;
    }
    case "invoice.payment_succeeded":
    default:
      break;
  }

  return { received: true };
}

export async function getBillingStatusForUser(userId) {
  const user = await User.findById(userId).lean();
  if (!user) return null;
  return {
    planKey: user.subscriptionPlanKey || "free",
    status: user.subscriptionStatus || "inactive",
    cancelAtPeriodEnd: Boolean(user.subscriptionCancelAtPeriodEnd),
    currentPeriodEnd: user.subscriptionCurrentPeriodEnd || null,
    stripeCustomerId: user.stripeCustomerId || null,
  };
}

export async function createPortalSessionForUser(user) {
  const { stripe, customerId } = await ensureStripeCustomerForUser(user);
  const appUrl = getClientAppUrl();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl}/upgrade`,
  });
  return { url: session.url };
}
