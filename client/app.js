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

const state = {
  socket: null,
  token: localStorage.getItem("rk_token") || "",
  agents: [],
  selectedHostname: null,
  pingTimer: null,
  pingMs: null
};

tokenInput.value = state.token;

function updateStatus(connected) {
  serverStatus.textContent = connected ? "Connected" : "Disconnected";
  serverStatus.style.color = connected ? "var(--success)" : "var(--danger)";
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

    const meta = document.createElement("div");
    meta.className = "agent-meta";
    meta.innerHTML = `
      <strong>${agent.hostname}</strong>
      <span>Last seen: ${new Date(agent.lastSeen).toLocaleTimeString()}</span>
      <span>GTA running: ${agent.gtaRunning ? "Yes" : "No"}</span>
    `;

    const action = document.createElement("div");
    action.className = "agent-action";
    const btn = document.createElement("button");
    btn.textContent = "Kill";
    btn.addEventListener("click", () => sendKill(agent.hostname));
    action.appendChild(btn);

    card.appendChild(meta);
    card.appendChild(action);
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
      latencyLabel.textContent = `Latency: ${state.pingMs} ms`;
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
  });

  state.socket.on("disconnect", () => {
    updateStatus(false);
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
