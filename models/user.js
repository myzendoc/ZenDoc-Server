import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true },
    lastName: { type: String },
    email: { type: String, required: true, unique: true, index: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["provider", "admin"], default: "provider" },
    onboardingComplete: { type: Boolean, default: false },
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
