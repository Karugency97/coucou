# OpenClaw → Coucou

Shows an OpenClaw Gateway (local or on a VPS) in the notch:

| Feature | Path |
|---|---|
| Live sessions (thinking, tools, finished) | `bridge.mjs` → Coucou socket, pill **OpenClaw** |
| Approvals (exec + plugin) | `bridge.mjs` → Allow / Always / Deny card → `exec.approval.resolve` / `plugin.approval.resolve` |
| Agent questions | `bridge.mjs` → question card (options or free text, up to 3 questions in a row) → `question.resolve`. Secret questions stay in OpenClaw |
| Chat | Coucou → `openclaw-chat.sock` → `chat.send`, streamed; one persistent `agent:<id>:coucou` session per agent (provider **OpenClaw** in the model picker, type `/new` to reset) |

GitHub build only (the App Store build has no approval cards for third-party agents).

## 1. Gateway (on the VPS)

Nothing to enable: everything goes through the Gateway WebSocket. Keep it behind TLS (`wss://`) —
the shared token is an owner credential. The HTTP `/v1/chat/completions` endpoint is not used.

## 2. Coucou

Settings → Chat — other providers → **OpenClaw**: Gateway URL (`wss://…`) and Gateway token → Save.
Both are stored in the Keychain. Then Settings → Active pills → toggle **OpenClaw** (agent) and/or **OpenClaw** (chat).

## 3. Bridge (on the Mac)

```bash
cd openclaw-bridge && npm install
node bridge.mjs            # add --debug to print every Gateway event
```

It reads the URL and token from Coucou's Keychain items (macOS asks once — click *Always Allow*),
or from `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN`.

First run: the Mac is a new device, so the Gateway asks for pairing (scopes `operator.read`,
`operator.write`, `operator.approvals`, `operator.questions`). On the VPS (Hostinger: `docker exec -it <container> …`):

```bash
openclaw devices list
openclaw devices approve <requestId>
```

The device key and the issued device token live in
`~/Library/Application Support/NotchBuddy/openclaw-device.json` (mode 600). Delete it to re-pair.

### Run at login (optional)

`~/Library/LaunchAgents/fr.karugency.coucou-openclaw.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>fr.karugency.coucou-openclaw</string>
  <key>ProgramArguments</key><array>
    <string>/ABSOLUTE/PATH/TO/node</string>
    <string>/ABSOLUTE/PATH/TO/openclaw-bridge/bridge.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/coucou-openclaw.log</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/fr.karugency.coucou-openclaw.plist
```

## Behaviour notes

- Approval answered elsewhere (Control UI, Telegram, `/approve`) → the card closes with "Handled in OpenClaw."
- No click within ~2 min → the card closes, the approval stays pending in OpenClaw.
- Approvals already pending when the bridge starts are not backfilled.
- Heartbeat runs are ignored (they would flood the pill).
