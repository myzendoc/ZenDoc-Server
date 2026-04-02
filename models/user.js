import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true },
    lastName: { type: String },
    email: { type: String, required: true, unique: true, index: true },
    password: { type: String },
    googleId: { type: String, unique: true, sparse: true, index: true },
    authProvider: { type: String, enum: ["local", "google"], default: "local" },
    displayName: { type: String },
    meetingUrl: { type: String },
    role: { type: String, enum: ["provider", "admin"], default: "provider" },
    onboardingComplete: { type: Boolean, default: false },
    verified: { type: Boolean, default: false },
    otpCode: { type: String },
    otpExpires: { type: Date },
    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date },
    stripeCustomerId: { type: String, index: true, sparse: true },
    stripeSubscriptionId: { type: String, index: true, sparse: true },
    stripePriceId: { type: String },
    subscriptionPlanKey: { type: String, default: "free", index: true },
    subscriptionStatus: { type: String, default: "inactive", index: true },
    subscriptionCurrentPeriodEnd: { type: Date },
    subscriptionCancelAtPeriodEnd: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userSchema.pre("save", function normalizeEmail(next) {
  if (this.email) {
    this.email = this.email.toLowerCase();
  }
  next();
});

export const User = mongoose.model("User", userSchema);
