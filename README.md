# Remote Killer (Windows)

Lightweight self-hosted remote process killer with optional Tailscale access control. The server hosts a mobile-friendly dashboard and coordinates multiple Windows agents. The dashboard can kill GTA5_Enhanced.exe on a single PC or all connected PCs at once. 

## Folder layout

- server/ - Express + Socket.IO server
- client/ - HTML/CSS/JS dashboard (served by the server)
- agent/ - Windows agent that runs taskkill

## Requirements

- Node.js 18+
- Optional: Tailscale (or another private VPN)
- Windows PCs for agents

## Setup

### 1) Server

```powershell
cd server
npm install
copy .env.example .env
```

Edit server/.env and set a strong SHARED_TOKEN.

Edit server/config.json to control access rules:

- tailscaleEnabled: false means only local network dashboard IPs can connect and send kill commands.
- tailscaleEnabled: true means only IPs in allowedTailscaleIps can connect and send kill commands.

Run the server:

```powershell
npm start
```

The dashboard is available at http://<server-ip>:3000

### 2) Agent (on each Windows PC)

```powershell
cd agent
npm install
copy .env.example .env
```

Edit agent/.env:

- SERVER_URL=http://<server-ip>:3000
- SHARED_TOKEN=the same value as the server
- HOSTNAME=optional override (defaults to Windows hostname)

Start the agent:

```powershell
npm start
```

## Network access notes

- If tailscaleEnabled is false, only local network dashboards can control kills.
- If tailscaleEnabled is true, add your tailnet dashboard IPs to allowedTailscaleIps.
- Do NOT expose the server publicly.

## Features

- Real-time connected PC list
- Kill GTA on one PC or all PCs
- Shared token auth for server, agents, and dashboard
- Live action logs
- Latency display
- Dark mode with toggle
- Mobile-friendly layout
- Auto-detect GTA running on each agent

## Security

- Change SHARED_TOKEN before running.
- Keep the server bound to your private network.
- Consider adding a reverse proxy with IP allow-list if needed.
