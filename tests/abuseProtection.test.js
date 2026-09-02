import assert from "node:assert/strict";
import test from "node:test";
import { User } from "../models/user.js";
import { createInMemoryRateLimiter } from "../middleware/rateLimit.js";
import { getNextLoginFailureState, LOGIN_LOCK_MS, MAX_LOGIN_FAILURES } from "../services/userService.js";

test("login lockout state is hidden from normal user reads", () => {
  assert.equal(User.schema.path("failedLoginAttempts").options.select, false);
  assert.equal(User.schema.path("loginLockedUntil").options.select, false);
  assert.equal(MAX_LOGIN_FAILURES, 5);
  assert.equal(LOGIN_LOCK_MS, 15 * 60 * 1000);
});

test("the fifth failed password attempt creates a temporary lock", () => {
  const now = 1_000;
  const state = getNextLoginFailureState(4, now);

  assert.equal(state.failedLoginAttempts, 0);
  assert.equal(state.loginLockedUntil.getTime(), now + LOGIN_LOCK_MS);
});

test("socket email limiter blocks repeated triggers until its window resets", () => {
  const consume = createInMemoryRateLimiter({ limit: 2, windowMs: 1_000 });

  assert.equal(consume("ip:room", 1_000).allowed, true);
  assert.equal(consume("ip:room", 1_100).allowed, true);
  assert.equal(consume("ip:room", 1_200).allowed, false);
  assert.equal(consume("ip:room", 2_001).allowed, true);
});
