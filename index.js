import { createServer } from "http";
import { Server } from "socket.io";
import { cpus } from "os";
import { createWorker } from "./worker.js";
import { createNewTransport } from "./transport.js";
import pidusage from "pidusage";
import { pipeToRouter } from "./pipeToRouter.js";
import { config } from "./config.js";
import { fileURLToPath } from "url";
import express from "express";
import helmet from "helmet";
import path from "path";
import { getPort, removePort } from "./ports.js";
import dotenv from 'dotenv'
import { spawn } from "child_process";
import { connectDatabase } from "./db.js";
import { saveFinalTranscript } from "./services/transcriptService.js";
import { sessionManager } from "./services/sessionManager.js";
import { getMeeting } from "./services/meetingService.js";
import apiRouter from "./routes/api.js";
import passport, { configurePassport } from "./config/passport.js";
import { auditHttpActivity } from "./middleware/audit.js";
import { createAuditLog } from "./services/auditLogService.js";
import { getIpFromSocket, getSocketAuditActor } from "./utils/audit.js";
import { getUserById, isUserIdActive } from "./services/userService.js";
import { sendWaitingRoomAlertEmail } from "./utils/mailer.js";
import { stripeWebhook } from "./controllers/billingController.js";
import { getRoomEntitlements, isFreeSessionLimitExceeded } from "./services/entitlementService.js";
import {
  createSocketAuthorization,
  getMeetingRole,
  getSocketMeeting,
  hasRoomAdmission,
  isMeetingCreatorJoin,
  isSocketRoomManager,
  isSocketRoomMember,
} from "./utils/socketAuth.js";
import { sendErrorResponse } from "./utils/errors.js";
import { logError } from "./utils/logging.js";
import { getTranscriptionProcessEnv } from "./utils/transcriptionProcess.js";
import { applyCors, isAllowedOrigin } from "./utils/origins.js";
import { authenticateSocketSession, revalidateSocketSession } from "./middleware/socketSession.js";
import { registerSocketDisconnector } from "./services/sessionRevocation.js";
import { startScheduledJobs, stopScheduledJobs } from "./services/scheduler.js";
import { consumeWaitingRoomEmailLimit } from "./middleware/rateLimit.js";

dotenv.config()

connectDatabase().then(()=>{
  console.log("Mongo connected");
  // Retention purge and audit-chain verification; lease-locked so only one instance runs them.
  startScheduledJobs();
}).catch((err) => {
  logError("database.connection_failed", err);
  process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", "loopback");
configurePassport();

const isDevelopment = process.env.NODE_ENV === "development";
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: [
          "'self'",
          "https://myzendoc.com",
          "https://www.myzendoc.com",
          "wss://myzendoc.com",
          "wss://www.myzendoc.com",
          ...(isDevelopment ? ["http://localhost:*", "ws://localhost:*"] : []),
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        workerSrc: ["'self'", "blob:"],
        upgradeInsecureRequests: isDevelopment ? null : [],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: isDevelopment
      ? false
      : { maxAge: 31536000, includeSubDomains: false, preload: false },
  })
);
app.use((_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()"
  );
  next();
});

app.use(applyCors);

app.use((req, res, next) => {
  if (String(req.originalUrl || "").startsWith("/api/billing/webhook")) {
    next();
    return;
  }
  express.json()(req, res, next);
});
app.post("/api/billing/webhook", express.raw({ type: "*/*" }), stripeWebhook);
app.use(passport.initialize());
app.use(
  "/api",
  (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  },
  auditHttpActivity,
  apiRouter
);
app.use(express.static(path.join(__dirname, "dist")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.use((err, req, res, next) => {
  logError("http.request_failed", err, { method: req?.method });
  if (res.headersSent) {
    next(err);
    return;
  }
  sendErrorResponse(res, err, { fallback: "Internal server error" });
});

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      callback(isAllowedOrigin(origin) ? null : new Error("Origin not allowed"), isAllowedOrigin(origin));
    },
    credentials: true,
  },
});

io.use(async (socket, next) => {
  try {
    socket.data.auth = await authenticateSocketSession(socket);
    next();
  } catch (err) {
    logError("socket.authentication_failed", err);
    socket.data.auth = null;
    next();
  }
});

// Drops live calls immediately instead of at the next revalidation.
registerSocketDisconnector(async (userId, reason) => {
  let dropped = 0;
  for (const socket of io.sockets.sockets.values()) {
    if (String(socket.data?.auth?.userId || "") !== String(userId)) continue;
    socket.data.auth = null;
    socket.emit("session-revoked", { reason });
    socket.disconnect(true);
    dropped += 1;
  }
  return dropped;
});

let Users = new Map();
let producerTransports = new Map();
let consumerTransports = new Map();
let producerCores;
let consumerCores;
let consumerRouters = [];
let membersinConsumerRouters = [];
let producerRouters = [];
let membersinProducerRouters = [];
let producersLimit = 300;
let consumersLimit = 600;
let pipedProducers = new Map();
let rooms = new Map();
let producerObjects = new Map();
let consumers = new Map();
let consumerObjects = new Map();
let uniquePipedProducers = [];
let waitingRooms = new Map();

const socketAuth = createSocketAuthorization({ io, rooms, waitingRooms, sessionManager });
const {
  admitSocketToRoom,
  authorizeWaitingWatchRoom,
  findRoomProducer,
  getSocketOwnedProducer,
  removeProducersFromRoom,
} = socketAuth;

function serializeWaitingUsers(room) {
  const list = waitingRooms.get(room) || [];
  return list.map((item) => ({
    socketId: item.socketId,
    peerId: item.peerId,
    username: item.username,
    room: item.room,
    requestedAt: item.requestedAt,
  }));
}

function emitWaitingUpdate(room) {
  const waiting = serializeWaitingUsers(room);
  io.to(`${room}-creator`).emit("waiting:update", { room, waiting });
  io.to(`waiting-watch-${room}`).emit("waiting:update", { room, waiting });
}

function canManageWaiting(socket, room) {
  return isSocketRoomManager(socket, room);
}

function removeWaitingSocket(socketId) {
  let changedRoom = null;
  for (const [room, list] of waitingRooms.entries()) {
    const next = list.filter((item) => item.socketId !== socketId);
    if (next.length !== list.length) {
      changedRoom = room;
      if (next.length > 0) {
        waitingRooms.set(room, next);
      } else {
        waitingRooms.delete(room);
      }
      emitWaitingUpdate(room);
      break;
    }
  }
  return changedRoom;
}

async function getProviderEmailForRoom(roomId) {
  if (!roomId) return "";
  const meeting = await getMeeting(roomId);
  if (!meeting?.createdBy) return "";
  const provider = await getUserById(String(meeting.createdBy));
  return String(provider?.email || "").trim().toLowerCase();
}

function maybeSendWaitingRoomAlert(socket, room, username) {
  const source = getIpFromSocket(socket) || socket.id;
  const rate = consumeWaitingRoomEmailLimit(`${source}:${room}`);
  if (!rate.allowed) return;
  getProviderEmailForRoom(room)
    .then((email) => sendWaitingRoomAlertEmail({ email, requesterName: username, roomId: room }))
    .catch((err) => logError("waiting_room.email_failed", err));
}

function getJoinAuditReason(message = "") {
  if (message === "Missing room id") return "missing_payload";
  if (message === "Invalid room link") return "invalid_room";
  if (message === "Waiting room approval required") return "approval_required";
  if (message === "Waiting for host to start the meeting") return "host_offline";
  return message ? "join_denied" : undefined;
}

function logSocketAudit(socket, { action, status = "success", payload = {}, resourceId = null, metadata = {} } = {}) {
  const actor = getSocketAuditActor(socket, payload);
  createAuditLog({
    ...actor,
    action,
    resourceType: "socket",
    resourceId,
    status,
    path: action,
    metadata,
  }).catch((err) => {
    logError("audit.socket_write_failed", err);
  });
}

io.on("connection", (socket) => {
  socket.data.waitingWatchRooms = new Set();
  socket.data.admittedRooms = new Set();
  socket.emit("session:authenticated", { authenticated: Boolean(socket.data.auth) });

  socket.use(async (_packet, next) => {
    try {
      await revalidateSocketSession(socket);
      next();
    } catch (err) {
      logError("socket.session_validation_failed", err);
      socket.data.auth = null;
      next();
    }
  });

  socket.on("waiting:watch", async ({ rooms: roomsToWatch } = {}, callback) => {
    const prevRooms = socket.data?.waitingWatchRooms || new Set();
    prevRooms.forEach((room) => {
      socket.leave(`waiting-watch-${room}`);
    });

    const nextRooms = new Set(
      Array.isArray(roomsToWatch)
        ? roomsToWatch.filter((room) => typeof room === "string" && room.trim()).map((room) => room.trim())
        : []
    );

    const allowedRooms = new Set();
    for (const room of nextRooms) {
      if (await authorizeWaitingWatchRoom(socket, room)) {
        allowedRooms.add(room);
      } else {
        logSocketAudit(socket, {
          action: "waiting:watch",
          status: "failure",
          payload: {},
          resourceId: room,
          metadata: { reason: "forbidden" },
        });
      }
    }

    socket.data.waitingWatchRooms = allowedRooms;
    allowedRooms.forEach((room) => {
      socket.join(`waiting-watch-${room}`);
      socket.emit("waiting:update", { room, waiting: serializeWaitingUsers(room) });
    });
    callback?.({ status: "ok", rooms: [...allowedRooms] });
  });

  socket.on("waiting:request", async ({ room, peerId, username } = {}, callback) => {
    if (!room || !peerId || !username) {
      logSocketAudit(socket, {
        action: "waiting:request",
        status: "failure",
        payload: { username },
        resourceId: room || null,
        metadata: { reason: "missing_payload" },
      });
      callback?.({ error: "Missing waiting room payload" });
      return;
    }
    const meeting = await getMeeting(room);
    if (!meeting) {
      logSocketAudit(socket, {
        action: "waiting:request",
        status: "failure",
        payload: { username },
        resourceId: room,
        metadata: { reason: "invalid_room" },
      });
      callback?.({ error: "Invalid room link" });
      return;
    }

    // A deactivated provider's rooms admit nobody, invite link or not.
    if (meeting.createdBy && !(await isUserIdActive(meeting.createdBy))) {
      logSocketAudit(socket, {
        action: "waiting:request",
        status: "failure",
        payload: { username },
        resourceId: room,
        metadata: { reason: "host_deactivated" },
      });
      callback?.({ error: "This meeting is no longer available. Contact your provider." });
      return;
    }

    const roomObj = rooms.get(room);
    const creatorSocket = roomObj?.creatorSocketId ? io.sockets.sockets.get(roomObj.creatorSocketId) : null;
    const isRequesterCreator = isMeetingCreatorJoin(meeting, socket.data?.auth);
    if (!roomObj || !roomObj?.creatorPeerId || !creatorSocket) {
      if (isRequesterCreator) {
        callback?.({ autoAdmit: true });
        return;
      }
      const list = waitingRooms.get(room) || [];
      const alreadyWaiting = list.some((item) => item.socketId === socket.id || item.peerId === peerId);
      if (!alreadyWaiting) {
        list.push({
          socketId: socket.id,
          peerId,
          username,
          room,
          requestedAt: Date.now(),
        });
        waitingRooms.set(room, list);
        emitWaitingUpdate(room);
      }
      callback?.({ queued: true });
      maybeSendWaitingRoomAlert(socket, room, username);
      logSocketAudit(socket, {
        action: "waiting:request",
        payload: { username },
        resourceId: room,
        metadata: { queued: true, peerId },
      });
      return;
    }
    if (isRequesterCreator) {
      callback?.({ autoAdmit: true });
      return;
    }

    const list = waitingRooms.get(room) || [];
    const alreadyWaiting = list.some((item) => item.socketId === socket.id || item.peerId === peerId);
    if (!alreadyWaiting) {
      list.push({
        socketId: socket.id,
        peerId,
        username,
        room,
        requestedAt: Date.now(),
      });
      waitingRooms.set(room, list);
      emitWaitingUpdate(room);
    }

    callback?.({ queued: true });
    maybeSendWaitingRoomAlert(socket, room, username);
    logSocketAudit(socket, {
      action: "waiting:request",
      payload: { username },
      resourceId: room,
      metadata: { queued: true, peerId },
    });
  });

  socket.on("waiting:approve", ({ room, socketId } = {}, callback) => {
    if (!room || !socketId) {
      logSocketAudit(socket, {
        action: "waiting:approve",
        status: "failure",
        payload: {},
        resourceId: room || null,
        metadata: { reason: "missing_payload" },
      });
      callback?.({ error: "Missing waiting approval payload" });
      return;
    }
    if (!canManageWaiting(socket, room)) {
      logSocketAudit(socket, {
        action: "waiting:approve",
        status: "failure",
        payload: {},
        resourceId: room,
        metadata: { reason: "forbidden" },
      });
      callback?.({ error: "Not allowed" });
      return;
    }

    const list = waitingRooms.get(room) || [];
    const target = list.find((item) => item.socketId === socketId);
    if (!target) {
      logSocketAudit(socket, {
        action: "waiting:approve",
        status: "failure",
        payload: {},
        resourceId: room,
        metadata: { reason: "target_not_found" },
      });
      callback?.({ error: "User not in waiting room" });
      return;
    }

    const next = list.filter((item) => item.socketId !== socketId);
    if (next.length > 0) {
      waitingRooms.set(room, next);
    } else {
      waitingRooms.delete(room);
    }

    admitSocketToRoom(socketId, room);
    io.to(socketId).emit("waiting:approved", {
      room,
      peerId: target.peerId,
      username: target.username,
    });
    emitWaitingUpdate(room);
    logSocketAudit(socket, {
      action: "waiting:approve",
      payload: {},
      resourceId: room,
      metadata: { targetPeerId: target.peerId },
    });
    callback?.({ status: "ok" });
  });

  socket.on("waiting:reject", ({ room, socketId } = {}, callback) => {
    if (!room || !socketId) {
      logSocketAudit(socket, {
        action: "waiting:reject",
        status: "failure",
        payload: {},
        resourceId: room || null,
        metadata: { reason: "missing_payload" },
      });
      callback?.({ error: "Missing waiting reject payload" });
      return;
    }
    if (!canManageWaiting(socket, room)) {
      logSocketAudit(socket, {
        action: "waiting:reject",
        status: "failure",
        payload: {},
        resourceId: room,
        metadata: { reason: "forbidden" },
      });
      callback?.({ error: "Not allowed" });
      return;
    }

    const list = waitingRooms.get(room) || [];
    const target = list.find((item) => item.socketId === socketId);
    if (!target) {
      logSocketAudit(socket, {
        action: "waiting:reject",
        status: "failure",
        payload: {},
        resourceId: room,
        metadata: { reason: "target_not_found" },
      });
      callback?.({ error: "User not in waiting room" });
      return;
    }

    const next = list.filter((item) => item.socketId !== socketId);
    if (next.length > 0) {
      waitingRooms.set(room, next);
    } else {
      waitingRooms.delete(room);
    }

    io.to(socketId).emit("waiting:rejected", {
      room,
      message: "Host denied your request",
    });
    emitWaitingUpdate(room);
    logSocketAudit(socket, {
      action: "waiting:reject",
      payload: {},
      resourceId: room,
      metadata: { targetPeerId: target.peerId },
    });
    callback?.({ status: "ok" });
  });

  socket.on("addUserCall", async (user, callback) => {
    removeWaitingSocket(socket.id);
    const room = typeof user?.room === "string" ? user.room.trim() : "";
    const peerId = typeof user?.peerId === "string" ? user.peerId.trim() : "";
    try {
      const result = await addUserCall(user, socket);
      const membership = getSocketMeeting(socket);
      logSocketAudit(socket, {
        action: "meeting.join",
        status: result?.error ? "failure" : "success",
        payload: { username: user?.username },
        resourceId: room || null,
        metadata: {
          peerId: peerId || undefined,
          role: membership?.role,
          reason: getJoinAuditReason(result?.error),
        },
      });
      callback?.(result);
    } catch (err) {
      logError("meeting.join_failed", err);
      logSocketAudit(socket, {
        action: "meeting.join",
        status: "failure",
        payload: { username: user?.username },
        resourceId: room || null,
        metadata: { peerId: peerId || undefined, reason: "exception" },
      });
      callback?.({ error: "Failed to join meeting" });
    }
  });

  socket.on("getRTPCapabilites", (callback) => {
    callback({ capabilities: producerRouters[0].router?.rtpCapabilities });
  });

  socket.on("createTransport", (id) => {
    createTransport(socket, id);
  });

  socket.on("stopTranscription", async ({ room, peerId }, callback) => {
    const membership = getSocketMeeting(socket);
    const authorizedRoom = membership?.room === room ? room : null;
    const roomObj = rooms.get(authorizedRoom);
    if (!roomObj) {
      logSocketAudit(socket, {
        action: "stopTranscription",
        status: "failure",
        payload: {},
        resourceId: room || null,
        metadata: { reason: "room_not_found", peerId },
      });
      callback?.({ error: "Room not found" });
      return;
    }
    if (!isSocketRoomManager(socket, room)) {
      logSocketAudit(socket, {
        action: "stopTranscription",
        status: "failure",
        payload: {},
        resourceId: room,
        metadata: { reason: "not_creator", peerId },
      });
      callback?.({ error: "Only the room creator can stop transcription" });
      return;
    }
    try {
      const result = await sessionManager.stopAndGenerate(room);
      const soaps = result?.soaps;
      if (soaps) {
        io.to(`${room}-creator`).emit("soapsGenerated", soaps);
        io.to(`${room}-creator`).emit("transcriptionStopped", soaps);
      } else {
        io.to(`${room}-creator`).emit("transcriptionStopped", result);
      }
      callback?.({ status: "ok", soaps });
      logSocketAudit(socket, {
        action: "stopTranscription",
        payload: {},
        resourceId: room,
        metadata: { peerId, soapsGenerated: Boolean(soaps) },
      });
    } catch (err) {
      logError("transcription.stop_failed", err);
      logSocketAudit(socket, {
        action: "stopTranscription",
        status: "failure",
        payload: {},
        resourceId: room,
        metadata: { reason: "exception", peerId },
      });
      callback?.({ error: "Failed to stop transcription" });
    }
  });

  socket.on("connectTransport", ({ dtlsParameters, id }, callback) => {
    connectTransport(socket, dtlsParameters, id, callback);
  });

  socket.on("produce", (data, callback) => {
    produce(data, socket, callback);
  });

  socket.on("chat", (message) => {
    const room = message?.room;
    const membership = getSocketMeeting(socket);
    if (!isSocketRoomMember(socket, room) || message?.peerId !== membership?.peerId) return;
    socket.broadcast.to(room).emit("chat", {
      ...message,
      room,
      peerId: membership.peerId,
      name: membership.username,
    });
  });

  socket.on("createConsumeTransport", (data) => {
    createConsumeTransport(data, socket);
  });

  socket.on("transportConnect", (data, callback) => {
    connectConsumerTransport(data, socket, callback);
  });

  socket.on("startConsuming", (data) => {
    startConsuming(data, socket);
  });

  socket.on("closeScreenShare", ({ producerIds, room }, callback) => {
    if (!isSocketRoomMember(socket, room) || !Array.isArray(producerIds)) {
      callback?.({ error: "Not allowed" });
      return;
    }
    const ownedProducerIds = producerIds.filter((producerId) => {
      const roomProducer = getSocketOwnedProducer(socket, producerId);
      return Boolean(roomProducer?.screenShare);
    });
    if (!ownedProducerIds.length) {
      callback?.({ error: "Not allowed" });
      return;
    }
    for (let i = 0; i < ownedProducerIds.length; i++) {
      const producer = producerObjects.get(ownedProducerIds[i]);
      producer?.close();
      producerObjects.delete(ownedProducerIds[i]);
      pipedProducers.delete(ownedProducerIds[i]);
    }
    removeProducersFromRoom(room, ownedProducerIds);
    callback?.({
      status: "OK",
    });
  });

  socket.on("handleProducer", async ({ producerId, state }, callback) => {
    if (!getSocketOwnedProducer(socket, producerId)) {
      callback?.({ error: "Not allowed" });
      return;
    }
    const producer = producerObjects.get(producerId);

    if (state) {
      await producer?.pause();
    } else {
      await producer?.resume();
    }

    callback?.({
      status: "OK",
    });
  });

  socket.on("producerRestartIce", async (id, callback) => {
    const transportObj = producerTransports.get(id);
    if (transportObj?.ownerSocketId !== socket.id) {
      callback?.({ error: "Not allowed" });
      return;
    }
    const transport = transportObj?.transport;
    const iceparams = await transport?.restartIce();
    callback?.(iceparams);
  });

  socket.on("consumerRestartIce", async (storageId, callback) => {
    const transportObj = consumerTransports.get(storageId);
    if (transportObj?.ownerSocketId !== socket.id) {
      callback?.({ error: "Not allowed" });
      return;
    }
    const transport = transportObj?.transport;
    const iceparams = await transport?.restartIce();
    callback?.(iceparams);
  });

  socket.on("closeProducer", ({ producerId, room }, callback) => {
    if (!isSocketRoomMember(socket, room) || !getSocketOwnedProducer(socket, producerId)) {
      callback?.({ error: "Not allowed" });
      return;
    }
    const producer = producerObjects.get(producerId);
    if (!producer) {
      callback?.({ error: "Producer not found" });
      return;
    }
    producer?.close();
    producerObjects.delete(producerId);
    pipedProducers.delete(producerId);
    removeProducersFromRoom(room, [producerId]);

    callback?.({
      status: "OK",
    });
  });

  socket.on("draw", (data) => {
    const room = data?.roomId;
    if (!isSocketRoomMember(socket, room)) return;
    socket.broadcast.to(room).emit("draw", { ...data, roomId: room });
  });

  socket.on("clearAnnotations", ({ roomId }) => {
    if (!isSocketRoomMember(socket, roomId)) return;
    socket.broadcast.to(roomId).emit("clearAnnotations");
  });

  socket.on("disconnecting", () => {
    const membership = getSocketMeeting(socket);
    if (membership?.room) {
      logSocketAudit(socket, {
        action: "meeting.leave",
        payload: { username: membership.username },
        resourceId: membership.room,
        metadata: { peerId: membership.peerId, role: membership.role },
      });
    }
    removeWaitingSocket(socket.id);
    handleDisconnecting(socket);
  });
});

function assignCores() {
  let cpuCores = cpus().length;
  if (cpuCores === 2) {
    producerCores = 1;
    consumerCores = 1;
  } else {
    producerCores = Math.floor(cpuCores / 4);
    consumerCores = Math.floor(cpuCores - producerCores);
  }
}

async function startMediasoup() {
  try {
    assignCores();
    for (let i = 0; i < producerCores; i++) {
      const [worker, router] = await createWorker();
      const webRtcServer = await worker.createWebRtcServer({
        listenInfos: config.mediasoup.webRtcServer.listenInfos,
      });

      producerRouters.push({
        router: router,
        workerPid: worker?.pid,
        webRtcServer: webRtcServer,
      });
      membersinProducerRouters.push(0);
    }

    for (let i = 0; i < consumerCores; i++) {
      const [worker, router] = await createWorker();
      const webRtcServer = await worker.createWebRtcServer({
        listenInfos: config.mediasoup.webRtcServer.listenInfos,
      });

      consumerRouters.push({
        router: router,
        workerPid: worker?.pid,
        webRtcServer: webRtcServer,
      });
      membersinConsumerRouters.push(0);
      uniquePipedProducers.push(new Map());
    }
  } catch (err) {
    throw err;
  }
}

startMediasoup();

async function addUserCall(user, socket) {
  const room = typeof user?.room === "string" ? user.room.trim() : "";
  const peerId = typeof user?.peerId === "string" ? user.peerId.trim() : "";
  const username = typeof user?.username === "string" ? user.username.trim() : "";
  if (!room || !peerId || !username) return { error: "Missing room id" };
  const meeting = await getMeeting(room);
  if (!meeting) return { error: "Invalid room link" };
  let roomObj = rooms.get(room);
  let role = "guest";
  const creatorJoin = isMeetingCreatorJoin(meeting, socket.data?.auth);
  const creatorSocket = roomObj?.creatorSocketId ? io.sockets.sockets.get(roomObj.creatorSocketId) : null;
  const creatorOnline = Boolean(roomObj?.creatorPeerId && creatorSocket);

  if (!creatorJoin && creatorOnline && !hasRoomAdmission(socket, room)) {
    return { error: "Waiting room approval required" };
  }

  if (!creatorJoin && !creatorOnline) {
    return { error: "Waiting for host to start the meeting" };
  }

  const entitlements = await getRoomEntitlements(room);

  if (!roomObj) {
    roomObj = {
      producers: [],
      creatorPeerId: creatorJoin ? peerId : null,
      creatorSocketId: creatorJoin ? socket.id : null,
      creatorUserId: creatorJoin && meeting?.createdBy ? String(meeting.createdBy) : null,
      screenShareAllowed: entitlements.screenShareAllowed,
      transcriptRecordingEnabled: true,
    };
    rooms.set(room, roomObj);
    if (creatorJoin) {
      role = getMeetingRole(meeting, socket.data?.auth).role;
      await sessionManager.startSession(room, {
        creatorPeerId: peerId,
        creatorSocketId: socket.id,
      });
    }
  } else if (creatorJoin) {
    role = getMeetingRole(meeting, socket.data?.auth).role;
    roomObj = {
      ...roomObj,
      creatorPeerId: peerId,
      creatorSocketId: socket.id,
      creatorUserId: meeting?.createdBy ? String(meeting.createdBy) : roomObj?.creatorUserId || null,
    };
    rooms.set(room, roomObj);
    await sessionManager.startSession(room, {
      creatorPeerId: peerId,
      creatorSocketId: socket.id,
    });
  }

  const session = sessionManager.getSessionContext(room);
  roomObj = {
    ...rooms.get(room),
    screenShareAllowed: entitlements.screenShareAllowed,
    transcriptRecordingEnabled: !isFreeSessionLimitExceeded(entitlements, session?.sessionIndex),
  };
  rooms.set(room, roomObj);

  socket.data.meeting = {
    room,
    peerId,
    username,
    role,
    userId: role === "guest" ? null : socket.data?.auth?.userId || null,
  };
  Users.set(socket.id, { room, peerId, username, role });
  socket.join(room);
  if (["creator", "admin"].includes(role)) {
    socket.join(`${room}-creator`);
  }
  socket.data.admittedRooms?.delete(room);
  const filteredProducers = rooms.get(room)?.producers || [];
  socket.emit("currentProducers", filteredProducers);
  return {
    isCreator: ["creator", "admin"].includes(role),
    screenShareAllowed: roomObj?.screenShareAllowed !== false,
    transcriptRecordingEnabled: roomObj?.transcriptRecordingEnabled !== false,
  };
}

async function getMinCPUUsageRouter(routers) {
  let minCPUUsageIdx = 0;
  try {
    const pids = routers?.map((router) => router?.workerPid);
    const usages = await new Promise((resolve, reject) => {
      pidusage(pids, (err, stats) => {
        if (err) {
          reject(err);
        } else {
          resolve(stats);
        }
      });
    });

    const keys = Object.keys(usages);

    minCPUUsageIdx = keys.reduce((minIndex, key, index) => {
      return usages[key].cpu < usages[keys[minIndex]].cpu ? index : minIndex;
    }, 0);
  } catch (err) {
    logError("media.cpu_usage_failed", err);
    minCPUUsageIdx = Math.floor(Math.random() * routers?.length);
  }

  return minCPUUsageIdx;
}

async function getProducerRouter() {
  let routerToReturnIdx = null;

  for (const [idx, item] of membersinProducerRouters.entries()) {
    if (item < producersLimit) {
      routerToReturnIdx = idx;
      break;
    }
  }

  if (routerToReturnIdx === null) {
    routerToReturnIdx = await getMinCPUUsageRouter(producerRouters);
  }

  return routerToReturnIdx;
}

async function createTransport(socket, id) {
  try {
    const membership = getSocketMeeting(socket);
    if (!membership || membership.peerId !== id) {
      socket.emit("transportCreated", { error: "Not allowed" });
      return;
    }
    let routerToUseIdx = await getProducerRouter();
    const { transport, params } = await createNewTransport(
      producerRouters[routerToUseIdx]?.router,
      producerRouters[routerToUseIdx]?.webRtcServer
    );
    producerTransports.set(id, {
      transport: transport,
      router: routerToUseIdx,
      ownerSocketId: socket.id,
      room: membership.room,
    });
    membersinProducerRouters[routerToUseIdx] += 1;
    socket.emit("transportCreated", { data: params });
  } catch (err) {
    logError("media.operation_failed", err);
  }
}

async function connectTransport(socket, params, id, callback) {
  try {
    const transportObj = producerTransports.get(id);
    if (transportObj?.ownerSocketId !== socket.id) {
      callback?.({ error: "Not allowed" });
      return;
    }
    const ProducerTransport = transportObj?.transport;
    await ProducerTransport.connect({ dtlsParameters: params });
    callback?.("ok");
  } catch (err) {
    logError("media.operation_failed", err);
  }
}

async function produce(data, socket, callback) {
  try {
    const { kind, rtpParameters, id, room } = data;
    const membership = getSocketMeeting(socket);
    if (!isSocketRoomMember(socket, room) || membership?.peerId !== id) {
      callback?.({ error: "Not allowed" });
      return;
    }
    const isScreenShare = data?.appData?.type === "screen";
    const roomObj = rooms.get(room);
    if (isScreenShare && roomObj?.screenShareAllowed === false) {
      callback?.({ error: "Screen sharing is available on Premium plan only." });
      return;
    }
    const ProducerTransportObj = producerTransports.get(id);
    if (ProducerTransportObj?.ownerSocketId !== socket.id || ProducerTransportObj?.room !== room) {
      callback?.({ error: "Not allowed" });
      return;
    }
    const ProducerTransport = ProducerTransportObj?.transport;

    const Producer = await ProducerTransport.produce({
      kind,
      rtpParameters,
      appData: data?.appData,
    });

    if (rooms.has(room)) {
      rooms.get(room)?.producers?.push({
        producerId: Producer.id,
        peerId: membership.peerId,
        room: room,
        kind: kind,
        screenShare: isScreenShare,
      });
    }

    producerObjects.set(Producer?.id, Producer);
    socket?.broadcast?.to(room)?.emit("newProducer", {
      producerId: Producer.id,
      peerId: membership.peerId,
      screenShare: isScreenShare,
    });

    if (kind === "audio" && roomObj?.transcriptRecordingEnabled !== false) {
      createVoiceRecognizer(Producer, producerRouters?.[ProducerTransportObj?.router]?.router, room, membership.peerId);
    }

    callback({
      producerId: Producer.id,
      kind: kind,
      screenShare: isScreenShare,
    });
  } catch (err) {
    logError("media.operation_failed", err);
    callback?.({ error: "Failed to publish media" });
  }
}

  async function createVoiceRecognizer(producer, router, roomId, peerId) {
    const rtpTransportConfig = config.mediasoup.plainTransport;
    const rtpTransport = await router.createPlainTransport(
      rtpTransportConfig
    );

    const remoteRtpPort = getPort();
    const remoteRtcpPort = getPort();

    await rtpTransport.connect({
      ip: "127.0.0.1",
      port: remoteRtpPort,
      rtcpPort: remoteRtcpPort,
    });

    const codecs = [];
    const routerCodec = router.rtpCapabilities.codecs.find(
      (codec) => codec.kind === "audio"
    );
    codecs.push(routerCodec);

    const rtpCapabilities = {
      codecs,
      rtcpFeedback: [],
    };

    const rtpConsumer = await rtpTransport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true,
    });

    const pythonProcess = spawn(
      "python3",
      [
        "./dataExtractor.py",
        remoteRtpPort,
        remoteRtcpPort,
        rtpTransport.rtcpTuple.localPort,
        rtpConsumer.rtpParameters.codecs[0].payloadType,
        rtpConsumer.rtpParameters.encodings[0].ssrc
      ],
      {
        env: getTranscriptionProcessEnv(),
      }
    );

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        rtpTransport?.close();
      } catch (err) {
        logError("media.rtp_transport_close_failed", err);
      }
      removePort(remoteRtpPort);
      removePort(remoteRtcpPort);
    };

    sessionManager.trackProcess(roomId, pythonProcess, cleanup);

    pythonProcess.stdout.on("data", (data) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          io.to(`${roomId}-creator`).emit('transcript',{msg, peerId})
          if (msg?.isFinal) {
            const session = sessionManager.getSessionContext(roomId);
            const roomObj = rooms.get(roomId);
            if (roomObj?.transcriptRecordingEnabled !== false) {
              saveFinalTranscript({
                roomId,
                peerId,
                text: msg?.text,
                sessionIndex: session?.sessionIndex,
                meetingSessionId: session?.sessionId,
              }).catch((err) =>
                logError("transcription.save_failed", err)
              );
            }
          }

        } catch (err) {
          logError("transcription.invalid_process_output", err);
        }
      }
    });

    pythonProcess.stderr.on("data", (err) => {
      console.log(err?.toString(),'err')
      logError("transcription.process_stderr");
    });

    pythonProcess.on("error", (err) => {
      logError("transcription.process_failed", err);
    });

    pythonProcess.on("close", () => {
      console.log("python process closed");
    });

    setTimeout(async () => {
      await rtpConsumer.resume();
    }, 1000);

    rtpConsumer.on("producerclose", () => {
      pythonProcess.kill();
      cleanup();
    });
  }


function create_UUID() {
  let dt = new Date().getTime();
  let uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
    /[xy]/g,
    function (c) {
      let r = (dt + Math.random() * 16) % 16 | 0;
      dt = Math.floor(dt / 16);
      return (c == "x" ? r : (r & 0x3) | 0x8).toString(16);
    }
  );
  return uuid;
}

async function createConsumeTransport(data, socket) {
  let storageId;
  let param;
  try {
    const membership = getSocketMeeting(socket);
    const producer = data?.producer || {};
    if (!isSocketRoomMember(socket, data?.room) || membership?.peerId !== data?.id) {
      socket.emit("ConsumeTransportCreated", { error: "Not allowed" });
      return;
    }
    const roomProducer = findRoomProducer(membership.room, producer?.producerId);
    if (!roomProducer || roomProducer.peerId !== producer?.peerId) {
      socket.emit("ConsumeTransportCreated", { error: "Producer not found" });
      return;
    }
    const routerIdx = await getConsumerRouter();
    const { transport, params } = await createNewTransport(
      consumerRouters[routerIdx]?.router,
      consumerRouters[routerIdx]?.webRtcServer
    );
    param = params;
    storageId = create_UUID();
    consumerTransports.set(storageId, {
      transport: transport,
      router: routerIdx,
      ownerSocketId: socket.id,
      ownerPeerId: membership.peerId,
      room: membership.room,
      producerId: producer?.producerId,
    });
    membersinConsumerRouters[routerIdx] += 1;
    if (consumers.has(data?.id)) {
      consumers.set(data?.id, [...consumers.get(data?.id), storageId]);
    } else {
      consumers.set(data?.id, [storageId]);
    }
    const originalRouterIdx = producerTransports.get(
      producer?.peerId
    )?.router;
    if (originalRouterIdx === undefined || originalRouterIdx === null) {
      throw new Error("Producer transport not found");
    }
    const filterPipedProducer = pipedProducers.get(producer?.producerId);

    if (filterPipedProducer) {
      const checkSameRouter = filterPipedProducer?.pipedRouters?.some(
        (router) => router.idx === routerIdx
      );
      if (!checkSameRouter) {
        let idxToUse =
          filterPipedProducer?.pipedRouters[
            filterPipedProducer?.pipedRouters?.length - 1
          ]?.idx;
        const result = await pipeToRouter(
          producer?.producerId,
          consumerRouters[idxToUse]?.router,
          consumerRouters[routerIdx]?.router
        );
        filterPipedProducer.pipedRouters = [
          ...filterPipedProducer?.pipedRouters,
          { type: "consumer", idx: routerIdx },
        ];
        filterPipedProducer.originalRouters = [
          ...filterPipedProducer?.originalRouters,
          { type: "consumer", idx: idxToUse },
        ];
        uniquePipedProducers[routerIdx].set(producer?.producerId, {
          consumers: new Set(),
          pipeConsumer: result?.pipeConsumer,
          pipeProducer: result?.pipeProducer,
        });
      }
    } else {
      const result = await pipeToRouter(
        producer?.producerId,
        producerRouters[originalRouterIdx]?.router,
        consumerRouters[routerIdx]?.router
      );
      pipedProducers.set(producer?.producerId, {
        pipedRouters: [{ type: "consumer", idx: routerIdx }],
        peerId: producer?.peerId,
        producerId: producer?.producerId,
        originalRouters: [{ type: "producer", idx: originalRouterIdx }],
      });
      uniquePipedProducers[routerIdx].set(producer?.producerId, {
        consumers: new Set(),
        pipeConsumer: result?.pipeConsumer,
        pipeProducer: result?.pipeProducer,
      });
    }
    socket.emit("ConsumeTransportCreated", {
      data: params,
      storageId: storageId,
      ...data,
      room: membership.room,
      id: membership.peerId,
    });
  } catch (err) {
    if (
      err?.toString() ===
      `Error: Channel request handler with ID ${data?.producer?.producerId} already exists [method:transport.produce]`
    ) {
      socket.emit("ConsumeTransportCreated", {
        data: param,
        storageId: storageId,
        ...data,
      });
      return;
    }
    logError("media.operation_failed", err);
  }
}

function pipeFactor(idx) {
  return uniquePipedProducers[idx]?.size || 0;
}

async function getConsumerRouter() {
  let routerToReturnIdx = null;

  for (const [idx, item] of membersinConsumerRouters.entries()) {
    if (item + pipeFactor(idx) < consumersLimit - 1) {
      routerToReturnIdx = idx;
      break;
    }
  }

  if (routerToReturnIdx === null) {
    routerToReturnIdx = await getMinCPUUsageRouter(consumerRouters);
  }

  return routerToReturnIdx;
}

async function connectConsumerTransport(data, socket, callback) {
  try {
    const transportObj = consumerTransports.get(data?.storageId);
    if (transportObj?.ownerSocketId !== socket.id) {
      callback?.({ error: "Not allowed" });
      return;
    }
    const consumeTrans = transportObj?.transport;
    await consumeTrans.connect({ dtlsParameters: data.dtlsParameters });
    callback?.("ok");
  } catch (err) {
    logError("media.operation_failed", err);
  }
}

function getUserName(peerId) {
  for (let [socketId, user] of Users) {
    if (peerId === user?.peerId) {
      return user?.username;
    }
  }
}

async function startConsuming(data, socket) {
  try {
    const transportObj = consumerTransports.get(data?.storageId);
    const membership = getSocketMeeting(socket);
    if (
      transportObj?.ownerSocketId !== socket.id ||
      transportObj?.room !== membership?.room ||
      transportObj?.ownerPeerId !== membership?.peerId ||
      transportObj?.producerId !== data?.producerId
    ) {
      socket.emit("consumerCreated", { error: "Not allowed" });
      return;
    }
    const roomProducer = findRoomProducer(membership.room, data?.producerId);
    if (!roomProducer || roomProducer.peerId !== data?.peerId) {
      socket.emit("consumerCreated", { error: "Producer not found" });
      return;
    }
    const consumeTrans = transportObj?.transport;
    const router = transportObj?.router;
    let consumer = await consumeTrans.consume({
      producerId: data?.producerId,
      rtpCapabilities: data?.rtpCapabilities,
      paused: data?.paused,
    });
    consumerObjects.set(data?.storageId, consumer);

    const uniquePipedProducersObj = uniquePipedProducers[router].get(
      data?.producerId
    )?.consumers;
    uniquePipedProducersObj?.add(consumer.id);

    const userName = getUserName(data?.peerId);

    socket.emit("consumerCreated", {
      producerId: data.producerId,
      kind: consumer.kind,
      id: consumer.id,
      rtpParameters: consumer.rtpParameters,
      storageId: data?.storageId,
      peerId: data?.peerId,
      paused: consumer?.paused,
      screenShare: data?.screenShare,
      muted: consumer?.producerPaused,
      userName: userName,
    });

    consumer.on("producerpause", () => {
      socket.emit("producerPaused", {
        storageId: data?.storageId,
        peerId: data?.peerId,
        kind: consumer?.kind,
      });
    });

    consumer.on("producerresume", () => {
      socket.emit("producerResumed", {
        storageId: data?.storageId,
        peerId: data?.peerId,
        kind: consumer?.kind,
      });
    });

    consumer.on("producerclose", () => {
      const consumerItem = consumerTransports.get(data?.storageId);
      const transport = consumerItem?.transport;
      const router = consumerItem?.router;
      transport?.close();
      membersinConsumerRouters[router] -= 1;
      const sockConsumers = consumers.get(data?.id);
      const filterConsumers = sockConsumers?.filter(
        (storageId) => storageId !== data?.storageId
      );
      consumers.set(data?.id, filterConsumers);
      consumerObjects.delete(data?.storageId);
      consumerTransports.delete(data?.storageId);
      socket.emit("closeConsumer", data?.storageId);
    });

    consumer.on("transportclose", () => {
      unpipeProducers(router, data?.producerId, consumer?.id);
    });
  } catch (err) {
    logError("media.operation_failed", err);
  }
}

function unpipeProducers(routerIdx, producerId, consumerId) {
  let uniqueObj = uniquePipedProducers[routerIdx].get(producerId);
  let consumersObj = uniqueObj?.consumers;

  if (consumersObj) {
    consumersObj.delete(consumerId);

    while (consumersObj?.size === 0) {
      const pipedObj = pipedProducers.get(producerId);
      const lastRouter =
        pipedObj?.pipedRouters?.[pipedObj?.pipedRouters?.length - 1];

      if (lastRouter?.idx === routerIdx) {
        unpipeProducer(uniquePipedProducers[routerIdx].get(producerId));
        uniquePipedProducers[routerIdx].delete(producerId);

        pipedObj?.pipedRouters?.pop();
        pipedObj?.originalRouters?.pop();

        if (pipedObj?.pipedRouters?.length === 0) {
          pipedProducers.delete(producerId);
          break;
        } else {
          routerIdx =
            pipedObj?.pipedRouters?.[pipedObj?.pipedRouters?.length - 1]?.idx;
          uniqueObj = uniquePipedProducers?.[routerIdx]?.get(producerId);
          consumersObj = uniqueObj?.consumers;
        }
      }
    }
  }
}

function handleDisconnecting(socket) {
  const roomsList = socket.rooms;

  const user = Users.get(socket.id);

  for (let room of roomsList) {
    if (room === socket.id) continue;
    const roomItem = rooms.get(room);

    const roomProducer = roomItem?.producers;
    if (roomProducer) {
      const removedProducers = roomProducer.filter(
        (producer) => producer?.peerId === user?.peerId
      );
      removedProducers.forEach((producer) => {
        producerObjects.delete(producer?.producerId);
        pipedProducers.delete(producer?.producerId);

        uniquePipedProducers.forEach((router) => {
          if (router?.has(producer?.producerId)) {
            router?.delete(producer?.producerId);
          }
        });
      });

      const remainingProducers = roomProducer.filter(
        (producer) => producer?.peerId !== user?.peerId
      );

      if (remainingProducers?.length > 0) {
        rooms.set(room, { ...rooms.get(room), producers: remainingProducers });
      } else {
        rooms.delete(room);
        waitingRooms.delete(room);
        sessionManager.endSession(room).catch((err) => logError("session.finalize_failed", err));
      }

      socket.broadcast.to(room).emit("userLeft", user);
    }
  }

  if (producerTransports.has(user?.peerId)) {
    const ProducerItem = producerTransports.get(user?.peerId);
    const Transport = ProducerItem?.transport;
    Transport?.close();
    const routerIdx = ProducerItem?.router;
    membersinProducerRouters[routerIdx] -= 1;
    producerTransports.delete(user?.peerId);
  }

  if (consumers.has(user?.peerId)) {
    const sockConsumers = consumers.get(user?.peerId);
    for (let i = 0; i < sockConsumers?.length; i++) {
      if (consumerTransports.has(sockConsumers[i])) {
        const consumerItem = consumerTransports.get(sockConsumers[i]);
        const transport = consumerItem?.transport;
        const router = consumerItem?.router;
        transport?.close();
        membersinConsumerRouters[router] -= 1;
        consumerTransports.delete(sockConsumers[i]);
      }
      if (consumerObjects.has(sockConsumers[i])) {
        consumerObjects.delete(sockConsumers[i]);
      }
    }
    consumers.delete(user?.peerId);
  }

  Users.delete(socket.id);
}

function unpipeProducer(item) {
  const pipeConsumer = item?.pipeConsumer;
  const pipeProducer = item?.pipeProducer;

  pipeProducer?.close();
  pipeConsumer?.close();
}

server.listen(5001, () => {
  console.log("Server Listening Successfully!");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopScheduledJobs();
    server.close(() => process.exit(0));
  });
}
