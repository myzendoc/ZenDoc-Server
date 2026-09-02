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
    status: { type: String, enum: ["active", "deactivated"], default: "active", index: true },
    deactivatedAt: { type: Date },
    deactivatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    deactivationReason: { type: String },
    reactivatedAt: { type: Date },
    mfa: {
      enabled: { type: Boolean, default: false },
      // Encrypted at rest via utils/fieldCipher.js, never returned by sanitizeUser.
      secret: { type: String, select: false },
      pendingSecret: { type: String, select: false },
      confirmedAt: { type: Date },
      lastUsedStep: { type: Number, select: false },
      recoveryCodes: {
        type: [
          {
            _id: false,
            hash: { type: String, required: true },
            usedAt: { type: Date, default: null },
          },
        ],
        default: undefined,
        select: false,
      },
    },
    failedLoginAttempts: { type: Number, default: 0, select: false },
    loginLockedUntil: { type: Date, select: false },
    otpCode: { type: String },
    otpExpires: { type: Date },
    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date },
    pendingEmail: { type: String },
    emailChangeOtp: { type: String },
    emailChangeOtpExpires: { type: Date },
    npiNumber: { type: String },
    primarySpecialty: { type: String },
    statesLicensed: { type: [String], default: [] },
    groupOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, sparse: true },
    stripeCustomerId: { type: String, index: true, sparse: true },
    stripeSubscriptionId: { type: String, index: true, sparse: true },
    stripePriceId: { type: String },
    subscriptionPlanKey: { type: String, default: "free", index: true },
    subscriptionStatus: { type: String, default: "inactive", index: true },
    subscriptionCurrentPeriodEnd: { type: Date },
    subscriptionCancelAtPeriodEnd: { type: Boolean, default: false },
    baa: {
      signed: { type: Boolean, default: false },
      organization: { type: String },
      signatoryName: { type: String },
      signatoryTitle: { type: String },
      signature: { type: String },
      signedAt: { type: Date },
      effectiveDate: { type: Date },
      documentVersion: { type: String },
      ipAddress: { type: String },
      emailedAt: { type: Date },
    },
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
