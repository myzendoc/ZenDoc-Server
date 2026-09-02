import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RETENTION_DAYS,
  getRetentionCutoff,
  getRetentionDays,
} from "../models/plugins/softDelete.js";
import { computeEntryHash, SIGNED_FIELDS } from "../utils/auditChain.js";

function withEnv(key, value, fn) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test("retention defaults to the six-year HIPAA documentation floor", () => {
  withEnv("PHI_RETENTION_DAYS", undefined, () => {
    assert.equal(getRetentionDays(), DEFAULT_RETENTION_DAYS);
    assert.ok(DEFAULT_RETENTION_DAYS >= 6 * 365);
  });
});

test("retention window is configurable but rejects nonsense values", () => {
  withEnv("PHI_RETENTION_DAYS", "30", () => assert.equal(getRetentionDays(), 30));
  // A bad value must not collapse the window to zero and purge everything.
  for (const bad of ["0", "-5", "abc", ""]) {
    withEnv("PHI_RETENTION_DAYS", bad, () => assert.equal(getRetentionDays(), DEFAULT_RETENTION_DAYS));
  }
});

test("the purge cutoff is the retention window in the past", () => {
  withEnv("PHI_RETENTION_DAYS", "10", () => {
    const now = Date.UTC(2026, 0, 31);
    const cutoff = getRetentionCutoff(now);
    assert.equal(cutoff.toISOString().slice(0, 10), "2026-01-21");
  });
});

test("the audit hash covers the fields an attacker would want to change", () => {
  for (const field of ["actorUserId", "action", "status", "resourceId", "ipAddress", "path"]) {
    assert.ok(SIGNED_FIELDS.includes(field), `${field} must be covered by the chain hash`);
  }
});

test("altering any signed field changes the entry hash", () => {
  withEnv("AUDIT_CHAIN_SECRET", "unit-test-secret", () => {
    const record = {
      eventId: "e1",
      actorUserId: "507f1f77bcf86cd799439011",
      action: "POST /admin/users/x/deactivate",
      status: "success",
      ipAddress: "10.0.0.1",
      path: "/admin/users/x/deactivate",
    };
    const base = computeEntryHash({ record, sequence: 7, previousHash: "abc" });

    for (const field of SIGNED_FIELDS) {
      const mutated = { ...record, [field]: "tampered" };
      assert.notEqual(
        computeEntryHash({ record: mutated, sequence: 7, previousHash: "abc" }),
        base,
        `changing ${field} must change the hash`
      );
    }

    // Reordering or re-linking must also break it.
    assert.notEqual(computeEntryHash({ record, sequence: 8, previousHash: "abc" }), base);
    assert.notEqual(computeEntryHash({ record, sequence: 7, previousHash: "def" }), base);
  });
});

test("the hash is stable across key insertion order", () => {
  withEnv("AUDIT_CHAIN_SECRET", "unit-test-secret", () => {
    const a = { eventId: "e1", action: "GET /x", status: "success" };
    const b = { status: "success", action: "GET /x", eventId: "e1" };
    assert.equal(
      computeEntryHash({ record: a, sequence: 1, previousHash: "" }),
      computeEntryHash({ record: b, sequence: 1, previousHash: "" })
    );
  });
});

test("a different secret produces a different hash", () => {
  const record = { eventId: "e1", action: "GET /x", status: "success" };
  const first = withEnv("AUDIT_CHAIN_SECRET", "secret-one", () =>
    computeEntryHash({ record, sequence: 1, previousHash: "" })
  );
  const second = withEnv("AUDIT_CHAIN_SECRET", "secret-two", () =>
    computeEntryHash({ record, sequence: 1, previousHash: "" })
  );
  assert.notEqual(first, second);
});

test("absent and empty signed fields hash identically", () => {
  withEnv("AUDIT_CHAIN_SECRET", "unit-test-secret", () => {
    const withNull = { eventId: "e1", action: "GET /x", status: "success", resourceId: null };
    const without = { eventId: "e1", action: "GET /x", status: "success" };
    assert.equal(
      computeEntryHash({ record: withNull, sequence: 1, previousHash: "" }),
      computeEntryHash({ record: without, sequence: 1, previousHash: "" })
    );
  });
});
