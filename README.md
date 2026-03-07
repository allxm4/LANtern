# LANtern

Wake on LAN web app. Add devices, tap the power button, they wake up. Installable as a PWA on iOS and Android.

Built for homelabs running on Linux (Raspberry Pi, NAS, mini PC) on the same LAN as your devices.

---

## Why

There are great projects out there like Upsnap that handle WoL along with status monitoring, shutdown, and more. For my setup though, my homelab mini PCs are managed through MeshCentral via Intel AMT, which keeps a persistent connection alive, meaning they always show as online regardless of whether they're actually powered on. That made status-based tools less useful for my specific case.

LANtern does one thing: send a magic packet. Open the app, tap the button, done.

---

## Security

LANtern has no built-in authentication beyond the optional PIN. **If you expose this outside your local network, put it behind proper authentication.** Cloudflare Zero Trust, a reverse proxy with basic auth, a VPN. The PIN alone is not enough for internet-facing deployments.

See [Remote access](#remote-access) below for options that work well with this setup.

---

## Install on your phone

**iOS:** Open in Safari, tap the Share button, select "Add to Home Screen".

**Android:** Open in Chrome, tap the three-dot menu, select "Add to Home Screen".

---

## Deploy

**1. Clone and create config files**

```bash
git clone https://github.com/allxm4/LANtern.git
cd LANtern
touch devices.json config.json
```

**2. Start**

```bash
docker compose up -d
```

**3. Open**

```
http://<your-server-ip>:3000
```

Devices and PIN config persist in `devices.json` and `config.json` next to `docker-compose.yml`.

---

## Changing the port

If port `3000` is already in use, change `PORT` in `docker-compose.yml`:

```yaml
environment:
  - PORT=8080
```

Then run `docker compose up -d` and access the app at `http://<your-server-ip>:8080`.

---

## Remote access

### Cloudflare Tunnel

Zero open ports. Traffic goes through Cloudflare's network. Pair this with a Cloudflare Access policy to gate it behind authentication.

1. [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → Networks → Tunnels → Create tunnel
2. Choose Cloudflared, name it, copy the token
3. In the tunnel's Public Hostname tab, point your domain to `http://localhost:3000`
4. Add to `.env`: `CLOUDFLARE_TOKEN=your-token`
5. Uncomment the `cloudflared` block in `docker-compose.yml`
6. `docker compose up -d`

### NetBird

Mesh VPN. The app is only reachable from devices enrolled in your NetBird network, with no public exposure.

1. [app.netbird.io](https://app.netbird.io) → Setup Keys → Create setup key (reusable)
2. Add to `.env`: `NETBIRD_SETUP_KEY=your-key`
3. Uncomment the `netbird` block and the `volumes` block in `docker-compose.yml`
4. `docker compose up -d`
5. Find the assigned IP under Peers in the NetBird dashboard, open `http://<netbird-ip>:3000`

---

## PIN lock

Set a PIN from the gear icon in the app. Sessions last 8 hours, so you won't be asked again on the same device until the session expires. The TTL is configurable via `SESSION_TTL_HOURS` in `docker-compose.yml`.

**Forgot your PIN:**

```bash
docker exec LANtern node reset-pin.js           # remove PIN
docker exec LANtern node reset-pin.js 1234      # set a new PIN
```

To immediately log out all active sessions:

```bash
docker compose restart wol
```

---

## API

All endpoints require authentication if a PIN is set. First get a session token, then include it in subsequent requests.

**Get a session token**

```bash
# With PIN enabled
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"pin":"1234"}'
# -> {"token":"abc123..."}

# Without PIN, call the same endpoint with no body
curl -s -X POST http://localhost:3000/api/auth/login
```

Pass the token in the `x-session-token` header on all subsequent requests.

---

**Wake by device ID**

Device IDs are UUIDs assigned when you add a device. Retrieve them from:

```bash
curl -s http://localhost:3000/api/devices \
  -H "x-session-token: <token>"
```

Then wake the device:

```bash
curl -s -X POST http://localhost:3000/api/wake/<device-id> \
  -H "x-session-token: <token>"
```

**Wake by MAC address** (useful for iOS Shortcuts or home automation)

```bash
curl -s -X POST http://localhost:3000/api/wake/mac/AA:BB:CC:DD:EE:FF \
  -H "Content-Type: application/json" \
  -H "x-session-token: <token>" \
  -d '{"broadcastAddress":"192.168.1.255"}'
```

`broadcastAddress` is optional, defaults to `255.255.255.255`.

**Health check** (no auth required)

```bash
curl -s http://localhost:3000/api/health
```
