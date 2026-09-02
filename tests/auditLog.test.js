import assert from "node:assert/strict";
import test from "node:test";
import { getAuditResource, shouldSkipAudit } from "../middleware/audit.js";
import { AuditLog } from "../models/auditLog.js";
import { sanitizeAuditMetadata, withAuditRetry } from "../services/auditLogService.js";
import { getSocketAuditActor } from "../utils/audit.js";

test("audit metadata only retains explicitly approved operational fields", () => {
  const metadata = sanitizeAuditMetadata({
    reason: "forbidden",
    peerId: "peer-1",
    content: "clinical text",
    summary: "diagnosis",
    organization: "private organization",
    token: "secret",
  });
  assert.deepEqual(metadata, { reason: "forbidden", peerId: "peer-1" });
});

test("audit persistence retries transient failures", async () => {
  let attempts = 0;
  const result = await withAuditRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("temporary failure");
    return "saved";
  }, [0, 0]);
  assert.equal(result, "saved");
  assert.equal(attempts, 3);
});

test("nested routes use the most specific resource identifier", () => {
  assert.deepEqual(
    getAuditResource({ params: { id: "meeting-1", noteId: "note-1" } }, "/api/dashboard/meetings/:id/notes/:noteId"),
    { resourceId: "note-1", resourceType: "soap_note", parentResourceId: "meeting-1" }
  );
  assert.equal(
    getAuditResource({ params: { userId: "user-2" } }, "/api/group/members/:userId").resourceId,
    "user-2"
  );
});

test("authenticated socket identity cannot be replaced by a participant payload name", () => {
  const actor = getSocketAuditActor(
    {
      data: {
        auth: { userId: "provider-1", role: "provider", actorName: "Dr Smith", actorEmail: "doctor@example.com" },
      },
      handshake: { headers: {} },
    },
    { username: "Patient Name" }
  );
  assert.equal(actor.actorUserId, "provider-1");
  assert.equal(actor.actorName, "Dr Smith");
  assert.equal(actor.actorEmail, "doctor@example.com");
});

test("session heartbeat noise is excluded from audit records", () => {
  assert.equal(shouldSkipAudit("/api/auth/session"), true);
  assert.equal(shouldSkipAudit("/api/auth/login"), false);
});

test("audit event identifiers are unique and compatible with legacy records", () => {
  const options = AuditLog.schema.path("eventId").options;
  assert.equal(options.unique, true);
  assert.equal(options.sparse, true);
});
