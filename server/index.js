const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const accessConfig = require("./config.json");
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const SHARED_TOKEN = process.env.SHARED_TOKEN;

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
  cors: {
    origin: false
  }
});

app.use(express.static(path.join(__dirname, "..", "client")));
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

const agentsById = new Map();
const agentIdByHostname = new Map();
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
  return Array.from(agentsById.values()).map((agent) => ({
    id: agent.id,
    hostname: agent.hostname,
    connectedAt: agent.connectedAt,
    lastSeen: agent.lastSeen,
    latencyMs: agent.latencyMs ?? null,
    gtaRunning: agent.gtaRunning ?? null,
    lastResult: agent.lastResult ?? null
  }));
}

function emitAgents() {
  io.to("dashboards").emit("agents:update", serializeAgents());
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
      const targetId = agentIdByHostname.get(hostname);
      if (!targetId) {
        socket.emit("kill:error", { message: `Agent not found: ${hostname}` });
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
      for (const [hostname, targetId] of agentIdByHostname.entries()) {
        io.to(targetId).emit("kill", { requestId, hostname });
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

  const agent = {
    id: socket.id,
    hostname,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    latencyMs: null,
    gtaRunning: null,
    lastResult: null
  };

  agentsById.set(socket.id, agent);
  agentIdByHostname.set(hostname, socket.id);
  addLog(`Agent connected: ${hostname}`);
  emitAgents();

  socket.on("agent:status", ({ gtaRunning }) => {
    agent.lastSeen = Date.now();
    agent.gtaRunning = gtaRunning;
    emitAgents();
  });

  socket.on("agent:ping", (payload, ack) => {
    if (typeof ack === "function") {
      ack({ serverTime: Date.now() });
    }
  });

  socket.on("agent:latency", ({ latencyMs }) => {
    agent.lastSeen = Date.now();
    agent.latencyMs = Number.isFinite(latencyMs) ? latencyMs : null;
    emitAgents();
  });

  socket.on("agent:killResult", ({ success, message, durationMs, requestId }) => {
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

  socket.on("disconnect", () => {
    agentsById.delete(socket.id);
    agentIdByHostname.delete(hostname);
    addLog(`Agent disconnected: ${hostname}`);
    emitAgents();
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
