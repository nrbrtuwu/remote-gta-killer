const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const accessConfig = require("./config.json");
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const SHARED_TOKEN = process.env.SHARED_TOKEN;
function readPositiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const SERVER_TIMINGS = {
  pingHeartbeatIntervalMs: readPositiveIntEnv("PING_HEARTBEAT_INTERVAL_MS", 500),
  timeoutToOfflineIntervalMs: readPositiveIntEnv("TIMEOUT_TO_OFFLINE_INTERVAL_MS", 300000),
  offlineDeviceDeleteIntervalMs: readPositiveIntEnv("OFFLINE_DEVICE_DELETE_INTERVAL_MS", 900000),
  socketIoPingIntervalMs: readPositiveIntEnv("SOCKETIO_PING_INTERVAL_MS", 25000),
  socketIoPingTimeoutMs: readPositiveIntEnv("SOCKETIO_PING_TIMEOUT_MS", 300000),
  agentStatusReportIntervalMs: readPositiveIntEnv("AGENT_STATUS_REPORT_INTERVAL_MS", 5000),
  killCommandTimeoutMs: readPositiveIntEnv("KILL_COMMAND_TIMEOUT_MS", 10000),
  shutdownAckTimeoutMs: readPositiveIntEnv("SHUTDOWN_ACK_TIMEOUT_MS", 500)
};

if (!SHARED_TOKEN) {
  console.error("Missing SHARED_TOKEN in environment.");
  process.exit(1);
}

if (!accessConfig) {
  console.error("Missing access config.");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket"],
  pingInterval: SERVER_TIMINGS.socketIoPingIntervalMs,
  pingTimeout: SERVER_TIMINGS.socketIoPingTimeoutMs,
  cors: {
    origin: false
  }
});

app.use(express.static(path.join(__dirname, "..", "client")));
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

const agentsById = new Map();
const agentsByHostname = new Map();
const logs = [];

function addLog(message) {
  const entry = {
    message,
    time: Date.now()
  };
  logs.push(entry);
  if (logs.length > 200) {
    logs.shift();
  }
  io.to("dashboards").emit("log", entry);
}

function serializeAgents() {
  return Array.from(agentsByHostname.values()).map((agent) => ({
    id: agent.socketId || agent.hostname,
    hostname: agent.hostname,
    connectedAt: agent.connectedAt,
    lastSeen: agent.lastSeen,
    latencyMs: agent.latencyMs ?? null,
    gtaRunning: agent.gtaRunning ?? null,
    lastResult: agent.lastResult ?? null,
    connected: agent.connected,
    pingUnresponsive: agent.pingUnresponsive
  }));
}

function emitAgents() {
  io.to("dashboards").emit("agents:update", serializeAgents());
}

function getAgentSettings() {
  return {
    pingHeartbeatIntervalMs: SERVER_TIMINGS.pingHeartbeatIntervalMs,
    timeoutToOfflineIntervalMs: SERVER_TIMINGS.timeoutToOfflineIntervalMs,
    offlineDeviceDeleteIntervalMs: SERVER_TIMINGS.offlineDeviceDeleteIntervalMs,
    socketIoPingIntervalMs: SERVER_TIMINGS.socketIoPingIntervalMs,
    socketIoPingTimeoutMs: SERVER_TIMINGS.socketIoPingTimeoutMs,
    agentStatusReportIntervalMs: SERVER_TIMINGS.agentStatusReportIntervalMs,
    killCommandTimeoutMs: SERVER_TIMINGS.killCommandTimeoutMs,
    shutdownAckTimeoutMs: SERVER_TIMINGS.shutdownAckTimeoutMs
  };
}

function getAgentPingIntervalMs() {
  return SERVER_TIMINGS.pingHeartbeatIntervalMs;
}

function getAgentPingTimeoutMs() {
  return SERVER_TIMINGS.socketIoPingTimeoutMs;
}

function getAgentPingOfflineGraceMs() {
  return SERVER_TIMINGS.timeoutToOfflineIntervalMs;
}

function getAgentOfflineGraceMs() {
  return SERVER_TIMINGS.offlineDeviceDeleteIntervalMs;
}

function clearPingLossTimer(agent) {
  if (agent.pingLossTimer) {
    clearTimeout(agent.pingLossTimer);
    agent.pingLossTimer = null;
  }
}

function markAgentPingLost(hostname, agent) {
  if (!agent.pingUnresponsive) {
    agent.pingUnresponsive = true;
    agent.pingLossStartedAt = Date.now();
  }

  if (!agent.pingLossTimer) {
    agent.pingLossTimer = setTimeout(() => {
      const currentAgent = agentsByHostname.get(hostname);
      if (!currentAgent || currentAgent.pingLossStartedAt !== agent.pingLossStartedAt) {
        return;
      }

      currentAgent.connected = false;
      currentAgent.socketId = null;
      currentAgent.latencyMs = null;
      currentAgent.offlineSince = Date.now();
      clearPingLossTimer(currentAgent);
      addLog(`Agent marked offline after ping loss: ${hostname}`);
      emitAgents();
      scheduleAgentCleanup(hostname, currentAgent);
    }, getAgentPingOfflineGraceMs());
  }
}

function schedulePingOffline(hostname, agent) {
  markAgentPingLost(hostname, agent);
}

function clearPingOffline(agent) {
  agent.pingUnresponsive = false;
  agent.pingLossStartedAt = null;
  clearPingLossTimer(agent);
}

function markAgentDisconnected(hostname, agent, message) {
  if (agent.cleanupTimer) {
    clearTimeout(agent.cleanupTimer);
    agent.cleanupTimer = null;
  }

  agent.connected = false;
  agent.socketId = null;
  agent.latencyMs = null;
  agent.offlineSince = Date.now();
  clearPingOffline(agent);
  addLog(message || `Agent disconnected: ${hostname}`);
  emitAgents();
  scheduleAgentCleanup(hostname, agent);
}

function pingAgent(hostname, socketId) {
  const socket = io.sockets.sockets.get(socketId);
  const agent = agentsById.get(socketId);
  if (!socket || !agent || !agent.connected) {
    return;
  }
  if (agent.pingInFlight) {
    return;
  }
  agent.pingInFlight = true;
  const started = Date.now();
  socket.timeout(getAgentPingTimeoutMs()).emit("server:ping", {}, (error) => {
    agent.pingInFlight = false;
    if (agentsByHostname.get(hostname)?.socketId !== socketId) {
      return;
    }
    if (error) {
      agent.latencyMs = null;
      agent.pingLossStartedAt = agent.pingLossStartedAt || Date.now();
      schedulePingOffline(hostname, agent);
      emitAgents();
      return;
    }
    agent.lastSeen = Date.now();
    agent.latencyMs = Date.now() - started;
    clearPingOffline(agent);
    emitAgents();
  });
}

function pingAgents() {
  for (const [hostname, agent] of agentsByHostname.entries()) {
    if (!agent.connected || !agent.socketId) {
      continue;
    }
    pingAgent(hostname, agent.socketId);
  }
}

function scheduleAgentCleanup(hostname, agent) {
  if (agent.cleanupTimer) {
    clearTimeout(agent.cleanupTimer);
  }

  agent.cleanupTimer = setTimeout(() => {
    const currentAgent = agentsByHostname.get(hostname);
    if (!currentAgent || currentAgent.connected || currentAgent.offlineSince !== agent.offlineSince) {
      return;
    }

    agentsByHostname.delete(hostname);
    addLog(`Agent removed after offline grace period: ${hostname}`);
    emitAgents();
  }, getAgentOfflineGraceMs());
}

function normalizeIp(rawIp) {
  if (!rawIp) {
    return "";
  }
  if (rawIp.startsWith("::ffff:")) {
    return rawIp.slice(7);
  }
  if (rawIp === "::1") {
    return "127.0.0.1";
  }
  return rawIp;
}

function isLocalIp(ip) {
  if (ip === "127.0.0.1") {
    return true;
  }
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  if (parts[0] === 10) {
    return true;
  }
  if (parts[0] === 192 && parts[1] === 168) {
    return true;
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  return false;
}

function getSocketIp(socket) {
  const rawIp = socket.handshake.address || socket.request?.connection?.remoteAddress;
  return normalizeIp(rawIp);
}

function isDashboardIpAllowed(socket) {
  const ip = getSocketIp(socket);
  if (!accessConfig.tailscaleEnabled) {
    return isLocalIp(ip);
  }
  const allowed = accessConfig.allowedTailscaleIps || [];
  return allowed.includes(ip);
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token || token !== SHARED_TOKEN) {
    return next(new Error("unauthorized"));
  }
  return next();
});

io.on("connection", (socket) => {
  const role = socket.handshake.auth?.role;

  if (role === "dashboard") {
    if (!isDashboardIpAllowed(socket)) {
      socket.emit("kill:error", {
        message: "Dashboard IP is not allowed by server access rules."
      });
      socket.disconnect(true);
      return;
    }
    socket.join("dashboards");
    socket.emit("init", {
      agents: serializeAgents(),
      logs
    });

    socket.on("ping:server", (payload, ack) => {
      if (typeof ack === "function") {
        ack({ serverTime: Date.now() });
      }
    });

    socket.on("kill:one", ({ hostname, requestId }) => {
      if (!isDashboardIpAllowed(socket)) {
        socket.emit("kill:error", { message: "IP not allowed for kill" });
        return;
      }
      const targetAgent = agentsByHostname.get(hostname);
      const targetId = targetAgent?.connected ? targetAgent.socketId : null;
      if (!targetId) {
        socket.emit("kill:error", { message: `Agent not connected: ${hostname}` });
        return;
      }
      addLog(`Kill request for ${hostname}`);
      io.to(targetId).emit("kill", { requestId, hostname });
    });

    socket.on("kill:all", ({ requestId }) => {
      if (!isDashboardIpAllowed(socket)) {
        socket.emit("kill:error", { message: "IP not allowed for kill" });
        return;
      }
      addLog("Kill request for ALL agents");
      for (const [hostname, targetAgent] of agentsByHostname.entries()) {
        if (!targetAgent.connected || !targetAgent.socketId) {
          continue;
        }
        io.to(targetAgent.socketId).emit("kill", { requestId, hostname });
      }
    });

    return;
  }

  if (role !== "agent") {
    socket.disconnect(true);
    return;
  }

  const hostname = socket.handshake.auth?.hostname;
  if (!hostname) {
    socket.disconnect(true);
    return;
  }

  const existingAgent = agentsByHostname.get(hostname);
  if (existingAgent && existingAgent.cleanupTimer) {
    clearTimeout(existingAgent.cleanupTimer);
    existingAgent.cleanupTimer = null;
  }

  const agent = existingAgent || {
    hostname,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    latencyMs: null,
    gtaRunning: null,
    lastResult: null,
    pingInFlight: false,
    connected: false,
    socketId: null,
    offlineSince: null,
    cleanupTimer: null,
    pingUnresponsive: false,
    pingLossStartedAt: null,
    pingLossTimer: null
  };

  if (agent.socketId && agent.socketId !== socket.id) {
    agentsById.delete(agent.socketId);
  }

  agent.id = socket.id;
  agent.socketId = socket.id;
  agent.connected = true;
  agent.connectedAt = agent.connectedAt || Date.now();
  agent.lastSeen = Date.now();
  agent.offlineSince = null;
  agent.pingInFlight = false;
  agent.gracefulShutdownRequested = false;
  clearPingOffline(agent);

  agentsById.set(socket.id, agent);
  agentsByHostname.set(hostname, agent);
  addLog(existingAgent ? `Agent reconnected: ${hostname}` : `Agent connected: ${hostname}`);
  emitAgents();
  socket.emit("server:settings", getAgentSettings());

  socket.on("agent:status", ({ gtaRunning }) => {
    if (!agent.connected) {
      return;
    }
    agent.lastSeen = Date.now();
    agent.gtaRunning = gtaRunning;
    emitAgents();
  });

  socket.on("agent:killResult", ({ success, message, durationMs, requestId }) => {
    if (!agent.connected) {
      return;
    }
    agent.lastSeen = Date.now();
    agent.lastResult = {
      success,
      message,
      durationMs,
      time: Date.now()
    };

    const status = success ? "SUCCESS" : "FAIL";
    addLog(`Kill result ${status} from ${hostname}: ${message}`);
    io.to("dashboards").emit("kill:result", {
      hostname,
      success,
      message,
      durationMs,
      time: Date.now()
    });
    emitAgents();
  });

  socket.on("agent:shutdown", ({ reason } = {}, ack) => {
    agent.gracefulShutdownRequested = true;
    markAgentDisconnected(hostname, agent, `Agent disconnected: ${hostname}`);
    if (typeof ack === "function") {
      ack({ ok: true, reason: reason || "shutdown" });
    }
  });

  socket.on("disconnect", () => {
    agentsById.delete(socket.id);
    if (agent.socketId !== socket.id) {
      return;
    }
    if (agent.gracefulShutdownRequested) {
      return;
    }
    addLog(`Agent connection lost: ${hostname}`);
    markAgentPingLost(hostname, agent);
    emitAgents();
  });
});

setInterval(pingAgents, getAgentPingIntervalMs());

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
