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
import path from "path";
import { getPort, removePort } from "./ports.js";
import dotenv from 'dotenv'
import { spawn } from "child_process";
import { connectDatabase } from "./db.js";
import { saveFinalTranscript } from "./services/transcriptService.js";
import { sessionManager } from "./services/sessionManager.js";
import { upsertMeeting } from "./services/meetingService.js";
import apiRouter from "./routes/api.js";

dotenv.config()

connectDatabase().catch((err) => {
  console.error("Mongo connection error", err);
  process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use("/api", apiRouter);
app.use(express.static(path.join(__dirname, "dist")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
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

io.on("connection", (socket) => {
  socket.on("addUserCall", (user, callback) => {
    const isCreator = addUserCall(user, socket);
    callback?.({ isCreator });
  });

  socket.on("getRTPCapabilites", (callback) => {
    callback({ capabilities: producerRouters[0].router?.rtpCapabilities });
  });

  socket.on("createTransport", (id) => {
    createTransport(socket, id);
  });

  socket.on("stopTranscription", async ({ room, peerId }, callback) => {
    const roomObj = rooms.get(room);
    if (!roomObj) {
      callback?.({ error: "Room not found" });
      return;
    }
    if (roomObj?.creatorPeerId !== peerId) {
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
    } catch (err) {
      console.error("stopTranscription error", err);
      callback?.({ error: "Failed to stop transcription" });
    }
  });

  socket.on("connectTransport", ({ dtlsParameters, id }, callback) => {
    connectTransport(dtlsParameters, id, callback);
  });

  socket.on("produce", (data, callback) => {
    produce(data, socket, callback);
  });

  socket.on("chat", (message) => {
    socket.broadcast.to(message?.room).emit("chat", message);
  });

  socket.on("createConsumeTransport", (data) => {
    createConsumeTransport(data, socket);
  });

  socket.on("transportConnect", (data, callback) => {
    connectConsumerTransport(data, callback);
  });

  socket.on("startConsuming", (data) => {
    startConsuming(data, socket);
  });

  socket.on("closeScreenShare", ({ producerIds, room }, callback) => {
    for (let i = 0; i < producerIds.length; i++) {
      const producer = producerObjects.get(producerIds[i]);
      producer?.close();
      producerObjects.delete(producerIds[i]);
      pipedProducers.delete(producerIds[i]);
    }
    const roomObj = rooms.get(room);
    const roomProd = roomObj?.producers;
    const producersFilter = roomProd?.filter(
      (producer) => !producerIds.some((id) => producer?.producerId === id)
    );
    rooms.set(room, { ...roomObj, producers: producersFilter });
    callback({
      status: "OK",
    });
  });

  socket.on("handleProducer", async ({ producerId, state }, callback) => {
    const producer = producerObjects.get(producerId);

    if (state) {
      await producer?.pause();
    } else {
      await producer?.resume();
    }

    callback({
      status: "OK",
    });
  });

  socket.on("producerRestartIce", async (id, callback) => {
    const transport = producerTransports.get(id)?.transport;
    const iceparams = await transport?.restartIce();
    callback(iceparams);
  });

  socket.on("consumerRestartIce", async (storageId, callback) => {
    const transport = consumerTransports.get(storageId)?.transport;
    const iceparams = await transport?.restartIce();
    callback(iceparams);
  });

  socket.on("closeProducer", ({ producerId, room }, callback) => {
    const producer = producerObjects.get(producerId);
    if (!producer) return;
    producer?.close();
    producerObjects.delete(producerId);
    pipedProducers.delete(producerId);
    const roomObj = rooms.get(room);
    const roomProd = roomObj?.producers;
    const producersFilter = roomProd?.filter(
      (producer) => producer?.producerId !== producerId
    );
    if (producersFilter?.length > 0) {
      rooms.set(room, { ...roomObj, producers: producersFilter });
    } else {
      rooms.delete(room);
      sessionManager.markSessionEnded(room);
    }

    callback({
      status: "OK",
    });
  });

  socket.on("draw", (data) => {
    socket.broadcast.to(data.roomId).emit("draw", data);
  });

  socket.on("clearAnnotations", ({ roomId }) => {
    socket.broadcast.to(roomId).emit("clearAnnotations");
  });

  socket.on("disconnecting", () => {
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

function addUserCall(user, socket) {
  if (!user?.room) return false;
  let roomObj = rooms.get(user?.room);
  let isCreator = false;

  if (!roomObj) {
    roomObj = { producers: [], creatorPeerId: user?.peerId, creatorSocketId: socket.id };
    rooms.set(user?.room, roomObj);
    isCreator = true;
    upsertMeeting({
      roomId: user?.room,
      creatorPeerId: user?.peerId,
      creatorSocketId: socket.id,
    }).catch(() => {});
  } else if (!roomObj?.creatorPeerId && user?.isCreator) {
    roomObj = { ...roomObj, creatorPeerId: user?.peerId, creatorSocketId: socket.id };
    rooms.set(user?.room, roomObj);
    isCreator = true;
    upsertMeeting({
      roomId: user?.room,
      creatorPeerId: user?.peerId,
      creatorSocketId: socket.id,
    }).catch(() => {});
  } else if (roomObj?.creatorPeerId === user?.peerId) {
    isCreator = true;
  }

  Users.set(socket.id, { ...user });
  socket.join(user?.room);
  if (isCreator) {
    socket.join(`${user?.room}-creator`);
  }
  const filteredProducers = rooms.get(user?.room)?.producers;
  socket.emit("currentProducers", filteredProducers);
  return isCreator;
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
    console.log(err, "while calculating cpu usage");
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
    let routerToUseIdx = await getProducerRouter();
    const { transport, params } = await createNewTransport(
      producerRouters[routerToUseIdx]?.router,
      producerRouters[routerToUseIdx]?.webRtcServer
    );
    producerTransports.set(id, {
      transport: transport,
      router: routerToUseIdx,
    });
    membersinProducerRouters[routerToUseIdx] += 1;
    socket.emit("transportCreated", { data: params });
  } catch (err) {
    console.log(err);
  }
}

async function connectTransport(params, id, callback) {
  try {
    const ProducerTransport = producerTransports.get(id)?.transport;
    await ProducerTransport.connect({ dtlsParameters: params });
    callback("ok");
  } catch (err) {
    console.log(err);
  }
}

async function produce(data, socket, callback) {
  try {
    const { kind, rtpParameters, id, room } = data;
    const ProducerTransportObj = producerTransports.get(id);
    const ProducerTransport = ProducerTransportObj?.transport;

    const Producer = await ProducerTransport.produce({
      kind,
      rtpParameters,
      appData: data?.appData,
    });

    if (rooms.has(room)) {
      rooms.get(room)?.producers?.push({
        producerId: Producer.id,
        peerId: id,
        room: room,
        kind: kind,
        screenShare: data?.appData?.type === "screen",
      });
    }

    producerObjects.set(Producer?.id, Producer);
    socket?.broadcast?.to(room)?.emit("newProducer", {
      producerId: Producer.id,
      peerId: id,
      screenShare: data?.appData?.type === "screen",
    });

    if (kind === "audio") {
     createVoiceRecognizer(Producer, producerRouters?.[ProducerTransportObj?.router]?.router, room, id);
    }

    callback({
      producerId: Producer.id,
      kind: kind,
      screenShare: data?.appData?.type === "screen",
    });
  } catch (err) {
    console.log(err);
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
        env: {
          ...process.env,
          //For macos dev only
          GI_TYPELIB_PATH: "/opt/homebrew/lib/girepository-1.0",
          GST_PLUGIN_SCANNER:
            "/opt/homebrew/libexec/gstreamer-1.0/gst-plugin-scanner",
          GST_PLUGIN_PATH: "/opt/homebrew/lib/gstreamer-1.0",
          DYLD_LIBRARY_PATH: "/opt/homebrew/lib",
          LD_LIBRARY_PATH: "/opt/homebrew/lib",
          PKG_CONFIG_PATH:
            "/opt/homebrew/lib/pkgconfig:/opt/homebrew/share/pkgconfig",
        },
      }
    );

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        rtpTransport?.close();
      } catch (err) {
        console.error("rtpTransport close error", err);
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
            saveFinalTranscript({ roomId, peerId, text: msg?.text }).catch((err) =>
              console.error("Transcript save error", err)
            );
          }

        } catch (e) {
          console.log("Non-JSON:", line);
        }
      }
    });

    pythonProcess.stderr.on("data", (err) => {
      console.log(err?.toString(), "err");
    });

    pythonProcess.on("error", (err) => {
      console.log(err, "an error ocurred");
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
    });
    membersinConsumerRouters[routerIdx] += 1;
    if (consumers.has(data?.id)) {
      consumers.set(data?.id, [...consumers.get(data?.id), storageId]);
    } else {
      consumers.set(data?.id, [storageId]);
    }
    const originalRouterIdx = producerTransports.get(
      data.producer?.peerId
    )?.router;
    const filterPipedProducer = pipedProducers.get(data?.producer?.producerId);

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
          data?.producer?.producerId,
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
        uniquePipedProducers[routerIdx].set(data?.producer?.producerId, {
          consumers: new Set(),
          pipeConsumer: result?.pipeConsumer,
          pipeProducer: result?.pipeProducer,
        });
      }
    } else {
      const result = await pipeToRouter(
        data?.producer?.producerId,
        producerRouters[originalRouterIdx]?.router,
        consumerRouters[routerIdx]?.router
      );
      pipedProducers.set(data?.producer?.producerId, {
        pipedRouters: [{ type: "consumer", idx: routerIdx }],
        peerId: data?.producer?.peerId,
        producerId: data?.producer?.producerId,
        originalRouters: [{ type: "producer", idx: originalRouterIdx }],
      });
      uniquePipedProducers[routerIdx].set(data?.producer?.producerId, {
        consumers: new Set(),
        pipeConsumer: result?.pipeConsumer,
        pipeProducer: result?.pipeProducer,
      });
    }
    socket.emit("ConsumeTransportCreated", {
      data: params,
      storageId: storageId,
      ...data,
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
    console.log(err);
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

async function connectConsumerTransport(data, callback) {
  try {
    const consumeTrans = consumerTransports.get(data?.storageId)?.transport;
    await consumeTrans.connect({ dtlsParameters: data.dtlsParameters });
    callback("ok");
  } catch (err) {
    console.log(err);
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
    console.log(err);
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
        sessionManager.markSessionEnded(room);
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
