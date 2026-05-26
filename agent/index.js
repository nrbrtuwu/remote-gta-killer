const os = require("os");
const { exec } = require("child_process");
const util = require("util");
const { io } = require("socket.io-client");
require("dotenv").config();

const execAsync = util.promisify(exec);

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const SHARED_TOKEN = process.env.SHARED_TOKEN;
const HOSTNAME = process.env.HOSTNAME || os.hostname();
const KILL_COMMAND = process.env.KILL_COMMAND || "taskkill /im GTA5_Enhanced.exe /f";
const CHECK_COMMAND =
  process.env.CHECK_COMMAND || 'tasklist /fi "imagename eq GTA5_Enhanced.exe"';
const DEFAULT_PING_HEARTBEAT_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_TO_OFFLINE_INTERVAL_MS = 300000;
const DEFAULT_OFFLINE_DEVICE_DELETE_INTERVAL_MS = 900000;
const SHUTDOWN_ACK_TIMEOUT_MS = 500;
const KILL_COMMAND_TIMEOUT_MS = 10000;

if (!SHARED_TOKEN) {
  console.error("Missing SHARED_TOKEN in environment.");
  process.exit(1);
}

const socket = io(SERVER_URL, {
  auth: {
    role: "agent",
    token: SHARED_TOKEN,
    hostname: HOSTNAME
  },
  reconnection: true,
  transports: ["websocket"]
});

let shuttingDown = false;
let serverSettings = {
  pingHeartbeatIntervalMs: DEFAULT_PING_HEARTBEAT_INTERVAL_MS,
  timeoutToOfflineIntervalMs: DEFAULT_TIMEOUT_TO_OFFLINE_INTERVAL_MS,
  offlineDeviceDeleteIntervalMs: DEFAULT_OFFLINE_DEVICE_DELETE_INTERVAL_MS
};
let statusTimer = null;

function readPositiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function setupStatusReporting() {
  if (statusTimer) {
    clearInterval(statusTimer);
  }

  statusTimer = setInterval(reportStatus, readPositiveInt(serverSettings.pingHeartbeatIntervalMs, DEFAULT_PING_HEARTBEAT_INTERVAL_MS));
}

function applyServerSettings(nextSettings = {}) {
  serverSettings = {
    pingHeartbeatIntervalMs: readPositiveInt(nextSettings.pingHeartbeatIntervalMs, DEFAULT_PING_HEARTBEAT_INTERVAL_MS),
    timeoutToOfflineIntervalMs: readPositiveInt(nextSettings.timeoutToOfflineIntervalMs, DEFAULT_TIMEOUT_TO_OFFLINE_INTERVAL_MS),
    offlineDeviceDeleteIntervalMs: readPositiveInt(nextSettings.offlineDeviceDeleteIntervalMs, DEFAULT_OFFLINE_DEVICE_DELETE_INTERVAL_MS)
  };

  setupStatusReporting();
}

function gracefulShutdown(reason = "shutdown") {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  const finish = () => {
    socket.disconnect();
    process.exit(0);
  };

  if (!socket.connected) {
    finish();
    return;
  }

  socket.emit("agent:shutdown", { reason });
  setTimeout(finish, SHUTDOWN_ACK_TIMEOUT_MS);
}

async function isGtaRunning() {
  try {
    const { stdout } = await execAsync(CHECK_COMMAND, { windowsHide: true });
    return stdout.toLowerCase().includes("gta5_enhanced.exe");
  } catch (error) {
    return false;
  }
}

async function reportStatus() {
  if (!socket.connected) {
    return;
  }
  const gtaRunning = await isGtaRunning();
  socket.emit("agent:status", { gtaRunning });
}

socket.on("connect", () => {
  console.log(`Connected to server as ${HOSTNAME}`);
  reportStatus();
});

socket.on("server:settings", (settings) => {
  applyServerSettings(settings);
});

socket.on("disconnect", () => {
  console.log("Disconnected from server");
});

process.on("SIGINT", () => gracefulShutdown("sigint"));
process.on("SIGTERM", () => gracefulShutdown("sigterm"));
process.on("beforeExit", () => {
  if (!shuttingDown) {
    gracefulShutdown("beforeExit");
  }
});

socket.on("server:ping", (payload, ack) => {
  if (typeof ack === "function") {
    ack({ agentTime: Date.now() });
  }
});

socket.on("kill", async ({ requestId } = {}) => {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(KILL_COMMAND, {
      windowsHide: true,
      timeout: KILL_COMMAND_TIMEOUT_MS
    });
    const durationMs = Date.now() - start;
    const message = (stdout || stderr || "Killed").trim();
    socket.emit("agent:killResult", {
      requestId,
      success: true,
      message,
      durationMs
    });
  } catch (error) {
    const durationMs = Date.now() - start;
    socket.emit("agent:killResult", {
      requestId,
      success: false,
      message: (error.stderr || error.message || "Unknown error").trim(),
      durationMs
    });
  }
});

applyServerSettings();
