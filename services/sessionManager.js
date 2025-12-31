import { getRoomTranscript } from "./transcriptService.js";
import { generateSoaps } from "./soapsService.js";
import { createSoapNote } from "./soapNoteService.js";
import { endMeeting, getMeeting } from "./meetingService.js";

class SessionManager {
  constructor() {
    this.rooms = new Map();
  }

  ensureRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, { processes: new Map(), sessionEnded: false });
    }
    return this.rooms.get(roomId);
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

  markSessionEnded(roomId) {
    if (!roomId) return;
    const room = this.ensureRoom(roomId);
    room.sessionEnded = true;
    endMeeting(roomId).catch(() => {});
  }

  stopAllProcesses(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const [process, cleanup] of room.processes.entries()) {
      try {
        process.kill("SIGKILL");
      } catch (err) {
        console.error("Failed to kill process", err);
      }
      try {
        cleanup?.();
      } catch (err) {
        console.error("Process cleanup error", err);
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
      console.error("Process cleanup error", err);
    }
  }

  async finalizeRoom(roomId) {
    const transcript = await getRoomTranscript(roomId);
    if (!transcript) return { transcript: "", soaps: null };
    const soaps = await generateSoaps(transcript);
    if (soaps) {
      const meeting = await getMeeting(roomId);
      await createSoapNote({
        roomId,
        content: soaps,
        meetingId: meeting?._id,
        createdBy: meeting?.createdBy,
      });
    }
    return { transcript, soaps };
  }

  async stopAndGenerate(roomId) {
    const room = this.ensureRoom(roomId);
    room.sessionEnded = true;
    this.stopAllProcesses(roomId);
    const result = await this.finalizeRoom(roomId);
    this.rooms.delete(roomId);
    return result;
  }
}

export const sessionManager = new SessionManager();
