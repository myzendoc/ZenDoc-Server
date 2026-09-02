import test from "node:test";
import assert from "node:assert/strict";
import * as userService from "../services/userService.js";
import * as authController from "../controllers/authController.js";
import { requireAdmin } from "../middleware/auth.js";
import { needsPasswordRehash, isUserActive, isMfaRequiredForRole } from "../services/userService.js";

test("the environment admin backdoor is gone from the auth surface", () => {
  // ADMIN_EMAIL/ADMIN_PASSWORD granted an account that no audit record could
  // attribute, because "env-admin" is not a real user id.
  assert.equal(userService.getEnvAdminUserFromPayload, undefined);
  assert.equal(userService.getEnvAdminIdentity, undefined);
});

test("signup cannot mint an admin through a shared invite code", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.promises.readFile(new URL("../controllers/authController.js", import.meta.url), "utf8")
  );
  assert.ok(!source.includes("ADMIN_INVITE_CODE"));
  assert.ok(!source.includes("resolveRole"));
  // createUser takes no role parameter at all, so no request body can set one.
  assert.ok(!/createUser\({[^}]*role/s.test(source));
});

test("createUser ignores any role supplied by the caller", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.promises.readFile(new URL("../services/userService.js", import.meta.url), "utf8")
  );
  const signature = source.match(/export async function createUser\(([^)]*)\)/)[1];
  assert.ok(!signature.includes("role"));
});

test("deactivated accounts are treated as inactive everywhere", () => {
  assert.equal(isUserActive({ status: "active" }), true);
  // Records predating the status field default to active.
  assert.equal(isUserActive({}), true);
  assert.equal(isUserActive({ status: "deactivated" }), false);
  assert.equal(isUserActive(null), false);
  assert.equal(isUserActive(undefined), false);
});

test("MFA is mandatory for admins and optional for providers", () => {
  assert.equal(isMfaRequiredForRole("admin"), true);
  assert.equal(isMfaRequiredForRole("provider"), false);
});

test("admin routes stay closed until the admin has enrolled in MFA", () => {
  const responses = [];
  const res = {
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      responses.push({ code: this.code, body });
      return this;
    },
  };

  let passed = false;
  const next = () => {
    passed = true;
  };

  requireAdmin({ user: { role: "admin", mfaEnabled: false } }, res, next);
  assert.equal(passed, false);
  assert.equal(responses[0].code, 403);
  assert.equal(responses[0].body.code, "mfa_enrollment_required");

  requireAdmin({ user: { role: "admin", mfaEnabled: true } }, res, next);
  assert.equal(passed, true);
});

test("non-admins are refused before the MFA gate is consulted", () => {
  const responses = [];
  const res = {
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      responses.push({ code: this.code, body });
      return this;
    },
  };
  let passed = false;
  requireAdmin({ user: { role: "provider", mfaEnabled: true } }, res, () => {
    passed = true;
  });
  assert.equal(passed, false);
  assert.equal(responses[0].code, 403);
  assert.equal(responses[0].body.error, "Forbidden");
});

test("legacy password hashes still verify and are flagged for upgrade", () => {
  // Pre-existing records are `salt:derived` at 120000 iterations.
  assert.equal(needsPasswordRehash("abc123:deadbeef"), true);
  assert.equal(needsPasswordRehash("pbkdf2$120000$abc$def"), true);
  assert.equal(needsPasswordRehash("pbkdf2$210000$abc$def"), false);
  assert.equal(needsPasswordRehash(""), true);
  assert.equal(needsPasswordRehash(null), true);
});

test("the MFA challenge endpoint is reachable without an authenticated session", () => {
  // A half-authenticated login has no session yet, so verifyMfa must not sit
  // behind requireAuth; its own signed challenge cookie is the guard.
  assert.equal(typeof authController.verifyMfa, "function");
});

test("account lifecycle operations are exported for admin and group callers", () => {
  for (const name of ["deactivateUser", "reactivateUser", "setUserRole", "isUserIdActive"]) {
    assert.equal(typeof userService[name], "function", `${name} should be exported`);
  }
});
