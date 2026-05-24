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
const CHECK_INTERVAL_MS = parseInt(
  process.env.CHECK_INTERVAL_MS || "5000",
  10
);

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
  reconnectionDelay: 500,
  reconnectionDelayMax: 2000,
  transports: ["websocket"]
});

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

socket.on("disconnect", () => {
  console.log("Disconnected from server");
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
      timeout: 10000
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

setInterval(reportStatus, CHECK_INTERVAL_MS);
