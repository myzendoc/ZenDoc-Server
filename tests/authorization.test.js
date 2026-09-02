import assert from "node:assert/strict";
import test from "node:test";
import { canAccessMeeting, serializePublicMeeting } from "../utils/authorization.js";

test("meeting access requires ownership even for a general administrator", () => {
  const meeting = { createdBy: "provider-1" };

  assert.equal(canAccessMeeting(meeting, { _id: "provider-1", role: "provider" }), true);
  assert.equal(canAccessMeeting(meeting, { _id: "provider-2", role: "provider" }), false);
  assert.equal(canAccessMeeting(meeting, { _id: "admin-1", role: "admin" }), false);
});

test("public meeting responses exclude ownership, description, and socket identifiers", () => {
  const meeting = serializePublicMeeting({
    roomId: "room-1",
    title: "Consultation",
    scheduledFor: "2026-07-29T12:00:00.000Z",
    description: "clinical context",
    createdBy: "provider-1",
    creatorPeerId: "peer-1",
    creatorSocketId: "socket-1",
  });

  assert.deepEqual(meeting, {
    roomId: "room-1",
    title: "Consultation",
    scheduledFor: "2026-07-29T12:00:00.000Z",
  });
});
