import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { verifyGoogleProfile } from "../controllers/authController.js";

let initialized = false;
let googleAuthEnabled = false;

export function configurePassport() {
  if (initialized) return passport;

  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const callbackURL = process.env.GOOGLE_CALLBACK_URL || "/api/auth/google/callback";

  if (clientID && clientSecret) {
    googleAuthEnabled = true;
    passport.use(
      new GoogleStrategy(
        {
          clientID,
          clientSecret,
          callbackURL,
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const payload = await verifyGoogleProfile(profile);
            done(null, payload);
          } catch (err) {
            done(err);
          }
        }
      )
    );
  }

  initialized = true;
  return passport;
}

export function isGoogleAuthEnabled() {
  return googleAuthEnabled;
}

export default passport;
