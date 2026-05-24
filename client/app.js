const tokenInput = document.getElementById("tokenInput");
const connectBtn = document.getElementById("connectBtn");
const serverStatus = document.getElementById("serverStatus");
const latencyLabel = document.getElementById("latency");
const agentCount = document.getElementById("agentCount");
const agentSelect = document.getElementById("agentSelect");
const killBtn = document.getElementById("killBtn");
const killAllBtn = document.getElementById("killAllBtn");
const agentList = document.getElementById("agentList");
const logList = document.getElementById("logList");
const bigViewBtn = document.getElementById("bigViewBtn");
const exitBigViewBtn = document.getElementById("exitBigViewBtn");

const state = {
  socket: null,
  token: localStorage.getItem("rk_token") || "",
  agents: [],
  selectedHostname: null,
  pingTimer: null,
  pingMs: null,
  connected: false
};

tokenInput.value = state.token;

const tabButtons = document.querySelectorAll(".tab");
const tabPanels = document.querySelectorAll(".tab-panel");
const mobileQuery = window.matchMedia("(max-width: 600px)");
let wakeLock = null;

async function requestWakeLock() {
  if (!state.connected || !mobileQuery.matches) {
    return;
  }
  if (!("wakeLock" in navigator)) {
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (err) {
    console.error(`Wake lock failed: ${err.name}, ${err.message}`);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

function setBigView(enabled) {
  document.body.classList.toggle("big-view", enabled);
}

function setConnectedState(connected) {
  state.connected = connected;
  document.body.classList.toggle("connected", connected);
  if (!connected) {
    setBigView(false);
    releaseWakeLock();
  } else {
    requestWakeLock();
  }
}

if (bigViewBtn) {
  bigViewBtn.addEventListener("click", () => setBigView(true));
}

if (exitBigViewBtn) {
  exitBigViewBtn.addEventListener("click", () => setBigView(false));
}

setConnectedState(false);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
});

mobileQuery.addEventListener("change", () => {
  if (mobileQuery.matches) {
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
});

function setActiveTab(targetId) {
  tabButtons.forEach((btn) => {
    const isActive = btn.dataset.tab === targetId;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === targetId);
  });
}

if (tabButtons.length) {
  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
  setActiveTab(tabButtons[0].dataset.tab);
}

function formatLatency(latencyMs) {
  if (!Number.isFinite(latencyMs)) {
    return "-- ms";
  }
  return `${Math.round(latencyMs)} ms`;
}

function getLatencyClass(latencyMs) {
  if (!Number.isFinite(latencyMs)) {
    return "muted";
  }
  if (latencyMs <= 50) {
    return "latency-0";
  }
  if (latencyMs <= 100) {
    return "latency-1";
  }
  if (latencyMs <= 150) {
    return "latency-2";
  }
  if (latencyMs <= 200) {
    return "latency-3";
  }
  return "latency-4";
}

function updateStatus(connected) {
  serverStatus.textContent = connected ? "Connected" : "Disconnected";
  serverStatus.classList.toggle("status-connected", connected);
  serverStatus.classList.toggle("status-disconnected", !connected);
}

function renderAgents() {
  agentCount.textContent = `Agents: ${state.agents.length}`;
  agentSelect.innerHTML = "";
  agentList.innerHTML = "";

  if (state.agents.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No agents";
    option.disabled = true;
    agentSelect.appendChild(option);
    return;
  }

  state.agents.forEach((agent) => {
    const option = document.createElement("option");
    option.value = agent.hostname;
    option.textContent = agent.hostname;
    agentSelect.appendChild(option);

    const card = document.createElement("div");
    card.className = "agent-card";

    const latencyText = formatLatency(agent.latencyMs);
    const latencyClass = getLatencyClass(agent.latencyMs);
    const latencyCellClass =
      latencyClass === "muted"
        ? "agent-cell muted"
        : `agent-cell ${latencyClass}`;
    const gtaClass = agent.gtaRunning ? "gta-yes" : "gta-no";
    card.innerHTML = `
      <div class="agent-cell" data-label="Hostname">${agent.hostname}</div>
      <div class="agent-cell muted" data-label="Last seen">${new Date(agent.lastSeen).toLocaleTimeString()}</div>
      <div class="${latencyCellClass}" data-label="Latency to server">${latencyText}</div>
      <div class="agent-cell ${gtaClass}" data-label="GTA running">${agent.gtaRunning ? "Yes" : "No"}</div>
    `;
    agentList.appendChild(card);
  });

  if (!state.selectedHostname) {
    state.selectedHostname = state.agents[0].hostname;
  }
  agentSelect.value = state.selectedHostname;
}

function addLog(entry) {
  const item = document.createElement("div");
  item.className = "log-entry";
  const time = new Date(entry.time || Date.now()).toLocaleTimeString();
  item.innerHTML = `<strong>${time}</strong> ${entry.message}`;
  logList.prepend(item);
}

function setupPing() {
  if (state.pingTimer) {
    clearInterval(state.pingTimer);
  }
  state.pingTimer = setInterval(() => {
    if (!state.socket || !state.socket.connected) {
      return;
    }
    const started = Date.now();
    state.socket.emit("ping:server", {}, () => {
      state.pingMs = Date.now() - started;
      latencyLabel.textContent = `Server latency: ${state.pingMs} ms`;
    });
  }, 2000);
}

async function sendKill(hostname) {
  if (!state.socket || !state.socket.connected) {
    addLog({ message: "Not connected", time: Date.now() });
    return;
  }
  state.socket.emit("kill:one", { hostname, requestId: Date.now() });
}

async function sendKillAll() {
  if (!state.socket || !state.socket.connected) {
    addLog({ message: "Not connected", time: Date.now() });
    return;
  }
  state.socket.emit("kill:all", { requestId: Date.now() });
}

connectBtn.addEventListener("click", () => {
  const token = tokenInput.value.trim();
  if (!token) {
    addLog({ message: "Token required", time: Date.now() });
    return;
  }
  localStorage.setItem("rk_token", token);
  state.token = token;

  if (state.socket) {
    state.socket.disconnect();
  }

  state.socket = io({
    auth: {
      role: "dashboard",
      token
    },
    transports: ["websocket"]
  });

  state.socket.on("connect", () => {
    updateStatus(true);
    setupPing();
    setConnectedState(true);
  });

  state.socket.on("disconnect", () => {
    updateStatus(false);
    setConnectedState(false);
  });

  state.socket.on("init", ({ agents, logs }) => {
    state.agents = agents;
    renderAgents();
    logList.innerHTML = "";
    logs.forEach(addLog);
  });

  state.socket.on("agents:update", (agents) => {
    state.agents = agents;
    renderAgents();
  });

  state.socket.on("log", (entry) => {
    addLog(entry);
  });

  state.socket.on("kill:result", (payload) => {
    if (payload.success && navigator.vibrate) {
      navigator.vibrate([120, 40, 120]);
    }
  });

  state.socket.on("kill:error", (payload) => {
    addLog({ message: payload.message, time: Date.now() });
  });
});

agentSelect.addEventListener("change", (event) => {
  state.selectedHostname = event.target.value;
});

killBtn.addEventListener("click", () => {
  if (!state.selectedHostname) {
    addLog({ message: "No agent selected", time: Date.now() });
    return;
  }
  sendKill(state.selectedHostname);
});

killAllBtn.addEventListener("click", sendKillAll);

updateStatus(false);
