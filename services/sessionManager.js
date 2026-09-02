import { getRoomTranscript } from "./transcriptService.js";
import { generateSoaps } from "./soapsService.js";
import { createSoapNote } from "./soapNoteService.js";
import { endMeetingSession, getLatestMeetingSessionForRoom, startMeetingSession } from "./meetingSessionService.js";
import { getMeeting, getMeetingById } from "./meetingService.js";
import { getUserById } from "./userService.js";
import { sendSessionEndedEmail, sendSoapReadyEmail } from "../utils/mailer.js";
import { getUserEntitlements, isFreeSessionLimitExceeded } from "./entitlementService.js";
import { logError } from "../utils/logging.js";

class SessionManager {
  constructor() {
    this.rooms = new Map();
  }

  ensureRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        processes: new Map(),
        sessionEnded: false,
        finalizing: false,
        finalizePromise: null,
        sessionId: null,
        sessionIndex: null,
        meetingId: null,
        createdBy: null,
      });
    }
    return this.rooms.get(roomId);
  }

  getSessionContext(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return {
      sessionId: room.sessionId,
      sessionIndex: room.sessionIndex,
      meetingId: room.meetingId,
      createdBy: room.createdBy,
    };
  }

  async startSession(roomId, { creatorPeerId, creatorSocketId } = {}) {
    if (!roomId) return null;
    const room = this.ensureRoom(roomId);
    if (room.sessionId && !room.sessionEnded) {
      return this.getSessionContext(roomId);
    }

    const started = await startMeetingSession({ roomId, creatorPeerId, creatorSocketId });
    const session = started?.session;
    const meeting = started?.meeting;
    room.sessionId = session?._id || null;
    room.sessionIndex = session?.sessionIndex ?? null;
    room.meetingId = meeting?._id || null;
    room.createdBy = meeting?.createdBy || null;
    room.sessionEnded = false;
    room.finalizing = false;
    room.finalizePromise = null;

    return this.getSessionContext(roomId);
  }

  trackProcess(roomId, process, cleanup) {
    if (!roomId || !process) return;
    const room = this.ensureRoom(roomId);
    room.processes.set(process, cleanup);
    const handler = () => {
      this.handleProcessCompletion(roomId, process);
      process.off?.("close", handler);
      process.off?.("exit", handler);
      process.removeListener?.("close", handler);
      process.removeListener?.("exit", handler);
    };
    process.on("close", handler);
    process.on("exit", handler);
  }

  stopAllProcesses(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const [process, cleanup] of room.processes.entries()) {
      try {
        process.kill("SIGKILL");
      } catch (err) {
        logError("session.process_kill_failed", err);
      }
      try {
        cleanup?.();
      } catch (err) {
        logError("session.process_cleanup_failed", err);
      }
    }
    room.processes.clear();
  }

  handleProcessCompletion(roomId, process) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const cleanup = room.processes.get(process);
    room.processes.delete(process);
    try {
      cleanup?.();
    } catch (err) {
      logError("session.process_cleanup_failed", err);
    }
  }

  async finalizeRoom(roomId) {
    const room = this.ensureRoom(roomId);
    const entitlements = await getUserEntitlements(room?.createdBy);
    const planLimitExceeded = isFreeSessionLimitExceeded(entitlements, room?.sessionIndex);

    if (planLimitExceeded) {
      return {
        transcript: "",
        soaps: null,
        sessionIndex: room.sessionIndex,
        sessionId: room.sessionId,
        planLimitExceeded: true,
      };
    }

    if (room.sessionIndex === undefined || room.sessionIndex === null) {
      return {
        transcript: "",
        soaps: null,
        sessionIndex: room.sessionIndex,
        sessionId: room.sessionId,
      };
    }

    const transcript = await getRoomTranscript(roomId, room.sessionIndex);
    if (!transcript) {
      return {
        transcript: "",
        soaps: null,
        sessionIndex: room.sessionIndex,
        sessionId: room.sessionId,
      };
    }

    const soaps = await generateSoaps(transcript);
    if (soaps) {
      await createSoapNote({
        roomId,
        content: soaps,
        meetingId: room.meetingId,
        meetingSessionId: room.sessionId,
        sessionIndex: room.sessionIndex,
        createdBy: room.createdBy,
      });
    }

    return {
      transcript,
      soaps,
      sessionIndex: room.sessionIndex,
      sessionId: room.sessionId,
    };
  }

  async resolveProviderEmail(roomId, room = null) {
    const roomState = room || this.rooms.get(roomId) || {};
    let createdBy = roomState?.createdBy ? String(roomState.createdBy) : "";

    if (!createdBy && roomState?.meetingId) {
      const meetingById = await getMeetingById(String(roomState.meetingId));
      if (meetingById?.createdBy) createdBy = String(meetingById.createdBy);
    }

    if (!createdBy && roomId) {
      const meetingByRoom = await getMeeting(roomId);
      if (meetingByRoom?.createdBy) createdBy = String(meetingByRoom.createdBy);
    }

    if (!createdBy) return "";
    const provider = await getUserById(createdBy);
    return String(provider?.email || "").trim().toLowerCase();
  }

  async sendSessionNotifications(roomId, result, room) {
    try {
      const email = await this.resolveProviderEmail(roomId, room);
      if (!email) return;

      const jobs = [sendSessionEndedEmail({ email, roomId })];
      if (result?.soaps) {
        jobs.push(sendSoapReadyEmail({ email, roomId }));
      }
      await Promise.allSettled(jobs);
    } catch (err) {
      logError("session.notification_failed", err);
    }
  }

  async endSession(roomId) {
    if (!roomId) return null;
    const room = this.ensureRoom(roomId);
    if (room.finalizePromise) {
      return room.finalizePromise;
    }

    if (!room.sessionId) {
      const latest = await getLatestMeetingSessionForRoom(roomId);
      if (latest) {
        room.sessionId = latest._id;
        room.sessionIndex = latest.sessionIndex;
        room.meetingId = latest.meetingId;
        room.createdBy = latest.createdBy || null;
      }
    }

    room.finalizing = true;
    room.sessionEnded = true;
    room.finalizePromise = (async () => {
      this.stopAllProcesses(roomId);
      const result = await this.finalizeRoom(roomId);
      await endMeetingSession({
        roomId,
        meetingSessionId: room.sessionId,
        sessionIndex: room.sessionIndex,
        endedAt: new Date(),
      });
      await this.sendSessionNotifications(roomId, result, room);
      this.rooms.delete(roomId);
      return result;
    })();

    try {
      return await room.finalizePromise;
    } finally {
      room.finalizing = false;
    }
  }

  async stopAndGenerate(roomId) {
    return this.endSession(roomId);
  }
}

export const sessionManager = new SessionManager();
