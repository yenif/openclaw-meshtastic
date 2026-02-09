# openclaw-meshtastic

[Meshtastic](https://meshtastic.org/) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw). Connects your AI agent to LoRa mesh radio networks.

## Architecture

```
┌─────────────┐     SSE/HTTP      ┌──────────────────┐    Serial     ┌───────────┐
│   OpenClaw   │◄────────────────►│  Python Bridge    │◄────────────►│  Meshtastic│
│   Gateway    │  :5000/messages  │  (Flask + SSE)    │  /dev/ttyUSB0│  Radio     │
│  + Plugin    │  :5000/send      │                   │              │            │
└─────────────┘                   └──────────────────┘              └───────────┘
```

**Two components:**
- **Plugin** (`plugin/`) — TypeScript OpenClaw channel plugin. Handles inbound message routing, DM vs public channel differentiation, session management, and outbound delivery.
- **Bridge** (`bridge/`) — Python Flask server. Connects to a Meshtastic device via serial, exposes an HTTP API with SSE streaming for real-time message delivery.

## Features

- **DM & public channel support** — Direct messages route to private sessions; public channel messages route to group sessions with broadcast replies
- **Multi-channel aware** — Supports Meshtastic channel indices (0-7)
- **Message chunking** — Auto-splits long replies to fit 230-byte LoRa limit
- **SSE streaming** — Event-driven, no polling
- **AllowFrom filtering** — Control which nodes can interact with your agent

## Quick Start

### 1. Deploy the Bridge

The bridge needs access to your Meshtastic radio via USB serial.

**Docker:**
```bash
cd bridge
docker build -t meshtastic-bridge .
docker run --device=/dev/ttyUSB0 -p 5000:5000 meshtastic-bridge
```

**Kubernetes:**
```bash
kubectl apply -f deploy/bridge-deployment.yaml
```

### 2. Install the Plugin

Copy the plugin to your OpenClaw extensions directory:
```bash
cp -r plugin/ ~/.openclaw/extensions/meshtastic/
```

Or install from npm (when published):
```bash
npm install openclaw-meshtastic
```

### 3. Configure OpenClaw

Add to your `openclaw.json`:
```json
{
  "channels": {
    "meshtastic": {
      "enabled": true,
      "bridgeUrl": "http://meshtastic-bridge:5000",
      "dm": {
        "policy": "allowlist",
        "allowFrom": ["!your_node_id"]
      }
    }
  },
  "plugins": {
    "load": {
      "paths": ["extensions/meshtastic"]
    }
  }
}
```

### 4. Verify

```bash
openclaw doctor
# Should show: meshtastic: configured
```

## Bridge API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/nodes` | GET | List known mesh nodes |
| `/messages` | GET | SSE stream of incoming messages |
| `/send` | POST | Send message: `{"text": "...", "to": "!nodeId", "channelIndex": 0}` |

### SSE Message Format

```json
{
  "from": "!433e1678",
  "fromName": "Brian",
  "to": "!433d24e8",
  "text": "Hello mesh!",
  "timestamp": 1770651444,
  "channel": 0,
  "isDirect": true
}
```

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the channel |
| `bridgeUrl` | string | `http://meshtastic-bridge.openclaw.svc:5000` | Bridge HTTP endpoint |
| `dm.policy` | string | `"allowlist"` | DM policy: open, allowlist, pairing, disabled |
| `dm.allowFrom` | string[] | `[]` | Node IDs allowed to DM (e.g., `["!433e1678"]`) |
| `agentId` | string | — | Route messages to a specific agent |

## Hardware

Tested with Heltec ESP32 LoRa devices running [Meshtastic firmware](https://meshtastic.org/docs/getting-started/flashing-firmware/).

Any Meshtastic-compatible device with serial/USB connection should work.

## License

MIT
