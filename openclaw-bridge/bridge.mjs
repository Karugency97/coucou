#!/usr/bin/env node
// Coucou ⇄ OpenClaw bridge.
// Connects to an OpenClaw Gateway as a paired operator device and relays
//   • live agent activity (lifecycle + tool events)  → Coucou hook socket (coucou_agent "openclaw")
//   • exec / plugin approval requests                 → Coucou approval card, decision → approval resolve
//   • agent questions (question.requested)            → Coucou question card, answer → question.resolve
//   • status line for the OpenClaw pill (health, today's cost, cron) + pairing/offline notices
//   • live headline per agent (session.observer)       → step on the agent's pill
//   • notch chat: local socket openclaw-chat.sock ⇄ chat.send / chat events (persistent agent:<id>:coucou session)

import { GatewayClient } from "@openclaw/gateway-client";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  agentEventToCoucou, approvalDecision, approvalToCoucou, historyTurns,
  observerToCoucou, questionToCoucou, statusSummary, textOf,
} from "./events.mjs";

// Timestamped log lines (launchd appends stdout/stderr to openclaw-bridge.log).
for (const level of ["log", "error"]) {
  const write = console[level].bind(console);
  console[level] = (...args) => write(new Date().toISOString(), ...args);
}

const APP_DIR = path.join(os.homedir(), "Library/Application Support/NotchBuddy");
const SOCK = process.env.COUCOU_SOCK ?? path.join(APP_DIR, "nb.sock");
const STATE_FILE = path.join(APP_DIR, "openclaw-device.json");
const CHAT_SOCK = path.join(APP_DIR, "openclaw-chat.sock");
const DEBUG = process.argv.includes("--debug");

// Same Keychain items Coucou writes from Settings → Chat → OpenClaw. Env vars win.
function keychain(account) {
  try {
    return execFileSync("security",
      ["find-generic-password", "-s", "fr.louisraille.NotchBuddy", "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch { return undefined; }
}
const url = process.env.OPENCLAW_GATEWAY_URL ?? keychain("openclaw-gateway-url");
const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? keychain("openclaw-gateway-token");
if (!url || !token) {
  console.error("Missing Gateway URL/token: set them in Coucou → Settings → OpenClaw, or OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN.");
  process.exit(1);
}

// ── Device identity (Ed25519, same derivation as OpenClaw) + issued device token ──
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}
function saveState(s) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
function rawPublicKey(publicKeyPem) {
  // SPKI DER for Ed25519 = 12-byte prefix + 32-byte raw key
  return crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }).subarray(-32);
}
let state = loadState();
if (!state?.privateKeyPem) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  state = {
    deviceId: crypto.createHash("sha256").update(rawPublicKey(publicKeyPem)).digest("hex"),
    publicKeyPem,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    tokens: {},
  };
  saveState(state);
}

// ── Coucou socket ──
function sendToCoucou(payload) {
  const s = net.createConnection(SOCK);
  s.on("error", () => {}); // Coucou not running → drop, never block
  s.end(JSON.stringify({ ...payload, coucou_agent: "openclaw" }) + "\n");
}

/** Shows the approval card; resolves "allow" | "always" | "deny" | "ask" | null (no answer). */
function askCoucou(payload) {
  const s = net.createConnection(SOCK);
  const decision = new Promise((resolve) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d) => { buf += d; });
    s.on("error", () => resolve(null));
    s.on("close", () => {
      try { resolve(JSON.parse(buf.split("\n")[0]).permissionDecision ?? null); } catch { resolve(null); }
    });
  });
  s.write(JSON.stringify({ ...payload, hook_event_name: "PermissionRequest", coucou_agent: "openclaw" }) + "\n");
  return { decision, cancel: () => s.destroy() };
}

// ── Gateway events → Coucou ──
function onAgentEvent(p) {
  const payload = agentEventToCoucou(p);
  if (payload) sendToCoucou(payload);
}

const pending = new Map(); // approval id → cancel()

async function onApprovalRequested(kind, p) {
  const payload = approvalToCoucou(kind, p);
  if (!payload || pending.has(p.id)) return;
  const ask = askCoucou(payload);
  pending.set(p.id, ask.cancel);
  const answer = await ask.decision;
  if (!pending.delete(p.id)) return; // resolved elsewhere meanwhile
  const decision = approvalDecision(answer);
  if (!decision) return; // "ask" / no answer → leave it to the other OpenClaw approval surfaces
  try {
    await client.request(`${kind}.approval.resolve`, { id: p.id, decision });
  } catch (e) {
    console.error(`resolve ${p.id} failed: ${e.message}`);
  }
}

function onApprovalResolved(p) {
  const cancel = pending.get(p?.id);
  if (cancel) { pending.delete(p.id); cancel(); } // closes the socket → Coucou shows "Handled in OpenClaw."
}

function onQuestionRequested(p) {
  const payload = questionToCoucou(p);
  if (payload) sendToCoucou(payload);
}

function onObserver(p) {
  const payload = observerToCoucou(p);
  if (payload) sendToCoucou(payload);
}

// ── Status line shown on the OpenClaw pill ──
function pushStatus(ok, summary, failing = []) {
  sendToCoucou({ hook_event_name: "OpenClawStatus", ok, summary, failing });
}

async function refreshStatus() {
  try {
    const [health, cost, cron, failing] = await Promise.all([
      client.request("health", {}),
      client.request("usage.cost", {}),
      client.request("cron.status", {}),
      client.request("cron.list", { compact: true, lastRunStatus: "error", limit: 200 }),
    ]);
    const s = statusSummary({ health, cost, cron, failing });
    pushStatus(s.ok, s.summary, s.failing);
  } catch (e) {
    console.error(`status: ${e.message}`);
  }
}

// Requests already pending when the bridge (re)connects.
async function backfill() {
  // ponytail: list items assumed to carry the same { id, request } shape as the *.requested events
  for (const kind of ["exec", "plugin"]) {
    try {
      const list = await client.request(`${kind}.approval.list`, {});
      for (const a of (Array.isArray(list) ? list : list?.approvals ?? [])) {
        void onApprovalRequested(kind, a.request ? a : { id: a.id, request: a });
      }
    } catch (e) { console.error(`${kind}.approval.list: ${e.message}`); }
  }
  try {
    const { questions = [] } = await client.request("question.list", {});
    for (const q of questions) if (q.status === "pending") onQuestionRequested(q);
  } catch (e) { console.error(`question.list: ${e.message}`); }
}

// ── Gateway client ──
const client = new GatewayClient({
  url,
  token,
  clientName: "cli",
  clientDisplayName: "Coucou",
  mode: "cli",
  role: "operator",
  scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
  caps: ["tool-events", "exec-approvals", "plugin-approvals"],
  minProtocol: PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  deviceIdentity: { deviceId: state.deviceId, publicKeyPem: state.publicKeyPem, privateKeyPem: state.privateKeyPem },
  hostDeps: {
    signDevicePayload: (pem, payload) => crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(pem)).toString("base64url"),
    publicKeyRawBase64UrlFromPem: (pem) => rawPublicKey(pem).toString("base64url"),
    loadDeviceAuthToken: ({ role }) => state.tokens?.[role] ?? null,
    storeDeviceAuthToken: ({ role, token, scopes }) => { state.tokens = { ...state.tokens, [role]: { token, scopes } }; saveState(state); },
    clearDeviceAuthToken: ({ role }) => { delete state.tokens?.[role]; saveState(state); },
    logError: (m) => console.error(m),
    logDebug: DEBUG ? (m) => console.log(m) : undefined,
  },
  onHelloOk: async () => {
    console.log(`Connected to ${url} as device ${state.deviceId.slice(0, 12)}…`);
    // Registers this connection for session.tool events of every session.
    try { await client.request("sessions.subscribe", {}); } catch (e) { console.error(`sessions.subscribe: ${e.message}`); }
    // Live per-session headlines (session.observer events).
    try { await client.request("sessions.observer.visibility", { visible: true }); } catch (e) { console.error(`observer: ${e.message}`); }
    await refreshStatus();
    await backfill();
  },
  onClose: (code, reason, info) => {
    console.error(`Closed: code=${code} reason=${reason || "-"} phase=${info?.phase ?? "?"}`);
    if (info?.phase === "post-hello") pushStatus(false, "Gateway offline · reconnecting…");
  },
  onGap: ({ expected, received }) => console.error(`Event gap: expected seq ${expected}, got ${received}`),
  // Paused (e.g. pairing pending): exit so launchd restarts us and we try again.
  onReconnectPaused: () => setTimeout(() => process.exit(1), 120_000),
  onConnectError: (e) => {
    const d = e.details ?? {};
    if (d.code === "PAIRING_REQUIRED" || e.gatewayCode === "PAIRING_REQUIRED" || d.requestId) {
      console.error(`Pairing required. On the Gateway host run:\n  openclaw devices list\n  openclaw devices approve ${d.requestId ?? "<requestId>"}`);
      pushStatus(false, `Pairing needed · openclaw devices approve ${d.requestId ?? "<id>"}`);
    } else {
      console.error(`Connect error: ${e.message}`);
    }
  },
  onEvent: (evt) => {
    if (DEBUG && evt.event !== "tick") console.log(evt.event, JSON.stringify(evt.payload)?.slice(0, 400));
    switch (evt.event) {
      case "agent":
      case "session.tool": return onAgentEvent(evt.payload);
      case "exec.approval.requested": return void onApprovalRequested("exec", evt.payload);
      case "plugin.approval.requested": return void onApprovalRequested("plugin", evt.payload);
      case "chat": return onChatEvent(evt.payload);
      case "session.observer": return onObserver(evt.payload);
      case "question.requested": return onQuestionRequested(evt.payload);
      case "question.resolved": return sendToCoucou({ hook_event_name: "OpenClawQuestionResolved", question_id: evt.payload?.id });
      case "exec.approval.resolved":
      case "plugin.approval.resolved": return onApprovalResolved(evt.payload);
    }
  },
});

// ── Notch chat: Coucou writes one JSON request line, the bridge answers with JSON event lines ──
//   {"op":"agents"}                         → {"type":"agents","agents":[…],"defaultId":"main"}
//   {"op":"send","agentId":"main","message":"…","attachments":[{type,mimeType,fileName,content(base64)}]?} → {"type":"delta","text":<cumulative>}… then {"type":"final","text":…} | {"type":"error","message":…}
//   {"op":"history","agentId":"main"}         → {"type":"history","messages":[{"role":"user"|"assistant","text":…}]} (last 30)
//   {"op":"abort","agentId":"main"}           → {"type":"ok"} (the running send then ends with "final" + text so far)
const chats = new Map(); // sessionKey → { text, write, end }

function onChatEvent(p) {
  const chat = chats.get(p?.sessionKey);
  if (!chat) return;
  if (p.state === "delta") {
    chat.text = p.replace ? p.deltaText : chat.text + (p.deltaText ?? "");
    chat.write({ type: "delta", text: chat.text });
  } else if (p.state === "final") {
    chat.end({ type: "final", text: textOf(p.message) || chat.text });
  } else if (p.state === "aborted") {
    chat.end({ type: "final", text: (chat.text || textOf(p.message)).trim() + "\n\n_(stopped)_" });
  } else if (p.state === "error") {
    chat.end({ type: "error", message: p.errorMessage ?? "Run failed" });
  }
}

async function handleChatRequest(req, conn) {
  const write = (obj) => { if (!conn.destroyed) conn.write(JSON.stringify(obj) + "\n"); };
  if (req.op === "answer") {
    await client.request("question.resolve", { id: req.id, answers: { answers: req.answers }, resolvedBy: "coucou" });
    return conn.end(JSON.stringify({ type: "ok" }) + "\n");
  }
  if (req.op === "agents") {
    const r = await client.request("agents.list", {});
    return conn.end(JSON.stringify({ type: "agents", defaultId: r.defaultId, agents: r.agents.map((a) => a.id) }) + "\n");
  }
  const agentId = /^[a-z0-9_-]{1,64}$/i.test(req.agentId ?? "") ? req.agentId : "main";
  // Current notch session per agent (persisted). /new and /reset need operator.admin on the
  // Gateway, which the bridge deliberately lacks: they start a fresh session key instead.
  const sessionKey = state.sessions?.[agentId] ?? `agent:${agentId}:coucou`;
  if (req.op === "send" && /^\/(new|reset)\s*$/i.test(req.message ?? "")) {
    state.sessions = { ...state.sessions, [agentId]: `agent:${agentId}:coucou-${Date.now().toString(36)}` };
    saveState(state);
    return conn.end(JSON.stringify({ type: "final", text: "New conversation started." }) + "\n");
  }
  if (req.op === "history") {
    const r = await client.request("chat.history", { sessionKey, limit: 200 });
    const messages = historyTurns(r.messages);
    return conn.end(JSON.stringify({ type: "history", messages }) + "\n");
  }
  if (req.op === "abort") {
    await client.request("chat.abort", { sessionKey });
    return conn.end(JSON.stringify({ type: "ok" }) + "\n");
  }
  if (req.op !== "send" || typeof req.message !== "string") throw new Error("bad request");
  chats.get(sessionKey)?.end({ type: "error", message: "Superseded by a newer message" });
  const chat = { text: "", write, end: (obj) => { chats.delete(sessionKey); write(obj); conn.end(); } };
  chats.set(sessionKey, chat);
  conn.on("close", () => { if (chats.get(sessionKey) === chat) chats.delete(sessionKey); });
  await client.request("chat.send", {
    sessionKey, agentId, message: req.message, idempotencyKey: crypto.randomUUID(),
    ...(Array.isArray(req.attachments) && req.attachments.length ? { attachments: req.attachments } : {}),
  });
}

fs.rmSync(CHAT_SOCK, { force: true });
net.createServer((conn) => {
  let buf = "";
  conn.setEncoding("utf8");
  conn.on("error", () => {});
  conn.on("data", (d) => {
    buf += d;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    conn.removeAllListeners("data");
    let req;
    try { req = JSON.parse(buf.slice(0, nl)); } catch { return conn.end(JSON.stringify({ type: "error", message: "bad request" }) + "\n"); }
    handleChatRequest(req, conn).catch((e) => {
      if (!conn.destroyed) conn.end(JSON.stringify({ type: "error", message: e.message }) + "\n");
    });
  });
}).listen(CHAT_SOCK, () => fs.chmodSync(CHAT_SOCK, 0o600));

client.start();
setInterval(refreshStatus, 5 * 60_000); // errors while disconnected are logged and skipped
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { client.stop(); process.exit(0); });
