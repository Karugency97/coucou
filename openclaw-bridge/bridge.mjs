#!/usr/bin/env node
// Coucou ⇄ OpenClaw bridge.
// Connects to an OpenClaw Gateway as a paired operator device and relays
//   • live agent activity (lifecycle + tool events)  → Coucou hook socket (coucou_agent "openclaw")
//   • exec / plugin approval requests                 → Coucou approval card, decision → approval resolve
//   • agent questions (question.requested)            → Coucou question card, answer → question.resolve
//   • notch chat: local socket openclaw-chat.sock ⇄ chat.send / chat events (persistent agent:<id>:coucou session)

import { GatewayClient } from "@openclaw/gateway-client";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

// ── Event mapping ──
const agentOf = (p) => p.agentId ?? /^agent:([^:]+):/.exec(p.sessionKey ?? "")?.[1] ?? "main";
const base = (p) => ({ session_id: p.sessionKey, cwd: `/openclaw/${agentOf(p)}` }); // Coucou names the pill after cwd's last component

// OpenClaw tool ids → names Coucou already knows how to label (frenchStep).
const TOOL_NAMES = { exec: "Bash", read: "Read", write: "Write", edit: "Edit", apply_patch: "Edit",
  web_fetch: "WebFetch", web_search: "WebSearch", spawn_agent: "Task" };

function onAgentEvent(p) {
  if (!p?.sessionKey || p.isHeartbeat) return;
  const d = p.data ?? {};
  if (p.stream === "lifecycle") {
    const name = { start: "UserPromptSubmit", end: "Stop", error: "StopFailure" }[d.phase];
    if (name) sendToCoucou({ ...base(p), hook_event_name: name });
  } else if (p.stream === "tool") {
    const tool_name = TOOL_NAMES[d.name] ?? d.name ?? "Tool";
    if (d.phase === "start") sendToCoucou({ ...base(p), hook_event_name: "PreToolUse", tool_name, tool_input: d.args ?? {} });
    else if (d.phase === "result") sendToCoucou({ ...base(p), hook_event_name: d.isError ? "PostToolUseFailure" : "PostToolUse", tool_name, tool_input: d.args ?? {} });
  }
}

const pending = new Map(); // approval id → cancel()

async function onApprovalRequested(kind, p) {
  const id = p?.id;
  const r = p?.request ?? {};
  if (!id || pending.has(id)) return;
  const toolInput = kind === "exec"
    ? { command: r.command ?? r.commandPreview ?? "(command)" }
    : { command: [r.title, r.description].filter(Boolean).join(" — ") || "Plugin approval" };
  const ask = askCoucou({
    session_id: r.sessionKey ?? id,
    cwd: `/openclaw/${r.agentId ?? agentOf(r)}`,
    tool_name: kind === "exec" ? "Bash" : (r.toolName ?? "Plugin"),
    tool_input: toolInput,
  });
  pending.set(id, ask.cancel);
  const answer = await ask.decision;
  if (!pending.delete(id)) return; // resolved elsewhere meanwhile
  const decision = { allow: "allow-once", always: "allow-always", deny: "deny" }[answer];
  if (!decision) return; // "ask" / no answer → leave it to the other OpenClaw approval surfaces
  try {
    await client.request(`${kind}.approval.resolve`, { id, decision });
  } catch (e) {
    console.error(`resolve ${id} failed: ${e.message}`);
  }
}

function onApprovalResolved(p) {
  const cancel = pending.get(p?.id);
  if (cancel) { pending.delete(p.id); cancel(); } // closes the socket → Coucou shows "Handled in OpenClaw."
}

// Secret questions (API keys…) stay in OpenClaw's own UI — never route secrets through the notch.
// ponytail: multiSelect is answered with one choice and "Other" free text only when there are no options.
function onQuestionRequested(p) {
  const qs = p?.questions ?? [];
  if (!p?.id || !qs.length || qs.some((q) => q.isSecret)) return;
  sendToCoucou({
    hook_event_name: "OpenClawQuestion",
    session_id: p.sessionKey ?? p.id,
    cwd: `/openclaw/${p.agentId ?? agentOf(p)}`,
    question: {
      id: p.id,
      items: qs.map((q) => ({
        id: q.questionId,
        text: q.question,
        options: (q.options ?? []).map((o) => o.label),
      })),
    },
  });
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
  },
  onConnectError: (e) => {
    const d = e.details ?? {};
    if (d.code === "PAIRING_REQUIRED" || e.gatewayCode === "PAIRING_REQUIRED" || d.requestId) {
      console.error(`Pairing required. On the Gateway host run:\n  openclaw devices list\n  openclaw devices approve ${d.requestId ?? "<requestId>"}`);
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
      case "question.requested": return onQuestionRequested(evt.payload);
      case "question.resolved": return sendToCoucou({ hook_event_name: "OpenClawQuestionResolved", question_id: evt.payload?.id });
      case "exec.approval.resolved":
      case "plugin.approval.resolved": return onApprovalResolved(evt.payload);
    }
  },
});

// ── Notch chat: Coucou writes one JSON request line, the bridge answers with JSON event lines ──
//   {"op":"agents"}                         → {"type":"agents","agents":[…],"defaultId":"main"}
//   {"op":"send","agentId":"main","message":"…"} → {"type":"delta","text":<cumulative>}… then {"type":"final","text":…} | {"type":"error","message":…}
const chats = new Map(); // sessionKey → { text, write, end }

function textOf(message) {
  if (typeof message === "string") return message;
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === "text").map((b) => b.text).join("");
  return "";
}

function onChatEvent(p) {
  const chat = chats.get(p?.sessionKey);
  if (!chat) return;
  if (p.state === "delta") {
    chat.text = p.replace ? p.deltaText : chat.text + (p.deltaText ?? "");
    chat.write({ type: "delta", text: chat.text });
  } else if (p.state === "final") {
    chat.end({ type: "final", text: textOf(p.message) || chat.text });
  } else if (p.state === "error" || p.state === "aborted") {
    chat.end({ type: "error", message: p.errorMessage ?? `Run ${p.state}` });
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
  if (req.op !== "send" || typeof req.message !== "string") throw new Error("bad request");
  const agentId = /^[a-z0-9_-]{1,64}$/i.test(req.agentId ?? "") ? req.agentId : "main";
  const sessionKey = `agent:${agentId}:coucou`;
  chats.get(sessionKey)?.end({ type: "error", message: "Superseded by a newer message" });
  const chat = { text: "", write, end: (obj) => { chats.delete(sessionKey); write(obj); conn.end(); } };
  chats.set(sessionKey, chat);
  conn.on("close", () => { if (chats.get(sessionKey) === chat) chats.delete(sessionKey); });
  await client.request("chat.send", { sessionKey, agentId, message: req.message, idempotencyKey: crypto.randomUUID() });
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
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { client.stop(); process.exit(0); });
