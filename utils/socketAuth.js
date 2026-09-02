import { getMeeting } from "../services/meetingService.js";
import { logError } from "./logging.js";

export function isMeetingCreatorJoin(meeting, auth = {}) {
  if (!meeting) return false;
  const meetingCreatorId = meeting?.createdBy ? String(meeting.createdBy) : "";
  const userId = auth?.userId ? String(auth.userId) : "";

  if (meetingCreatorId) {
    if (userId && userId === meetingCreatorId) return true;
  }
  return false;
}

export function getMeetingRole(meeting, auth = {}) {
  const meetingCreatorId = meeting?.createdBy ? String(meeting.createdBy) : "";
  const userId = auth?.userId ? String(auth.userId) : "";
  if (meetingCreatorId && userId === meetingCreatorId) {
    return { role: "creator", userId };
  }
  return { role: "guest", userId: null };
}

export function getSocketMeeting(socket) {
  return socket.data?.meeting || null;
}

export function isSocketRoomMember(socket, room) {
  const membership = getSocketMeeting(socket);
  return Boolean(membership?.room === room && socket.rooms.has(room));
}

export function isSocketRoomManager(socket, room) {
  if (!socket.data?.auth) return false;
  const membership = getSocketMeeting(socket);
  if (membership?.room === room && ["creator", "admin"].includes(membership?.role)) return true;
  const watchedRooms = socket.data?.waitingWatchRooms;
  return Boolean(watchedRooms instanceof Set && watchedRooms.has(room));
}

export function hasRoomAdmission(socket, room) {
  const admittedRooms = socket.data?.admittedRooms;
  return Boolean(admittedRooms instanceof Set && admittedRooms.has(room));
}

export function createSocketAuthorization({ io, rooms, waitingRooms, sessionManager }) {
  function admitSocketToRoom(socketId, room) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (!targetSocket) return;
    if (!(targetSocket.data.admittedRooms instanceof Set)) {
      targetSocket.data.admittedRooms = new Set();
    }
    targetSocket.data.admittedRooms.add(room);
  }

  function findRoomProducer(room, producerId) {
    const roomObj = rooms.get(room);
    return roomObj?.producers?.find((producer) => producer?.producerId === producerId) || null;
  }

  function getSocketOwnedProducer(socket, producerId) {
    const membership = getSocketMeeting(socket);
    if (!membership?.room || !producerId) return null;
    const roomProducer = findRoomProducer(membership.room, producerId);
    if (!roomProducer || roomProducer.peerId !== membership.peerId) return null;
    return roomProducer;
  }

  function removeProducersFromRoom(room, producerIds = []) {
    const roomObj = rooms.get(room);
    const ids = new Set(producerIds.filter(Boolean));
    const roomProd = roomObj?.producers || [];
    const producersFilter = roomProd.filter((producer) => !ids.has(producer?.producerId));
    if (producersFilter.length > 0) {
      rooms.set(room, { ...roomObj, producers: producersFilter });
    } else {
      rooms.delete(room);
      waitingRooms.delete(room);
      sessionManager.endSession(room).catch((err) => logError("session.finalize_failed", err));
    }
  }

  async function authorizeWaitingWatchRoom(socket, room) {
    if (!room) return false;
    if (isSocketRoomManager(socket, room)) return true;
    const meeting = await getMeeting(room);
    if (!meeting) return false;
    const role = getMeetingRole(meeting, socket.data?.auth);
    if (!["creator", "admin"].includes(role.role)) return false;
    return true;
  }

  return {
    admitSocketToRoom,
    authorizeWaitingWatchRoom,
    findRoomProducer,
    getSocketOwnedProducer,
    removeProducersFromRoom,
  };
}
