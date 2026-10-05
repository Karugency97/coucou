// node --test   (payloads below are shaped like real events seen on an OpenClaw 2026.9 Gateway)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentEventToCoucou, approvalDecision, approvalToCoucou, historyTurns,
  observerToCoucou, questionToCoucou, statusSummary,
} from "./events.mjs";

const run = { runId: "r1", seq: 1, ts: 0, sessionKey: "agent:sales:coucou", agentId: "sales" };

test("lifecycle and tool events map to Coucou hook events on the agent's pill", () => {
  assert.deepEqual(agentEventToCoucou({ ...run, stream: "lifecycle", data: { phase: "start" } }), {
    session_id: "agent:sales:coucou", cwd: "/openclaw/sales", openclaw_agent: "sales", hook_event_name: "UserPromptSubmit",
  });
  assert.equal(agentEventToCoucou({ ...run, stream: "lifecycle", data: { phase: "end" } }).hook_event_name, "Stop");
  assert.equal(agentEventToCoucou({ ...run, stream: "lifecycle", data: { phase: "model" } }), null);

  const tool = agentEventToCoucou({ ...run, stream: "tool", data: { phase: "start", name: "ls", args: { path: "." } } });
  assert.equal(tool.hook_event_name, "PreToolUse");
  assert.equal(tool.tool_name, "LS");
  assert.deepEqual(tool.tool_input, { path: "." });
  assert.equal(agentEventToCoucou({ ...run, stream: "tool", data: { phase: "result", name: "exec", isError: true } }).hook_event_name,
    "PostToolUseFailure");
  assert.equal(agentEventToCoucou({ ...run, stream: "tool", data: { phase: "start", name: "custom_tool" } }).tool_name, "custom_tool");
});

test("heartbeat runs, sessionless events and other streams are ignored", () => {
  assert.equal(agentEventToCoucou({ ...run, isHeartbeat: true, stream: "lifecycle", data: { phase: "start" } }), null);
  assert.equal(agentEventToCoucou({ stream: "lifecycle", data: { phase: "start" } }), null);
  assert.equal(agentEventToCoucou({ ...run, stream: "assistant", data: { text: "ok" } }), null);
});

test("agent id falls back to the session key", () => {
  const p = agentEventToCoucou({ sessionKey: "agent:veille:coucou-x1", stream: "lifecycle", data: { phase: "start" } });
  assert.equal(p.openclaw_agent, "veille");
});

test("exec and plugin approvals become a PermissionRequest; decisions map back", () => {
  const exec = approvalToCoucou("exec", { id: "a1", request: { command: "echo hi", agentId: "main", sessionKey: "agent:main:coucou" } });
  assert.deepEqual(exec, {
    session_id: "agent:main:coucou", cwd: "/openclaw/main", openclaw_agent: "main",
    tool_name: "Bash", tool_input: { command: "echo hi" },
  });
  const plugin = approvalToCoucou("plugin", { id: "p1", request: { title: "Send", description: "Post to Slack", toolName: "slack" } });
  assert.equal(plugin.tool_name, "slack");
  assert.equal(plugin.tool_input.command, "Send — Post to Slack");
  assert.equal(approvalToCoucou("exec", { request: {} }), null);

  assert.equal(approvalDecision("allow"), "allow-once");
  assert.equal(approvalDecision("always"), "allow-always");
  assert.equal(approvalDecision("deny"), "deny");
  assert.equal(approvalDecision("ask"), undefined);
  assert.equal(approvalDecision(null), undefined);
});

test("questions: options and free text forwarded, secret questions never", () => {
  const q = questionToCoucou({
    id: "q1", agentId: "main",
    questions: [{ questionId: "couleur", header: "Test", question: "Quelle couleur ?", options: [{ label: "Rouge" }, { label: "Bleu" }] }],
  });
  assert.equal(q.hook_event_name, "OpenClawQuestion");
  assert.deepEqual(q.question.items, [{ id: "couleur", text: "Quelle couleur ?", options: ["Rouge", "Bleu"] }]);
  assert.equal(questionToCoucou({ id: "q2", questions: [{ questionId: "k", header: "Key", question: "API key?", options: [], isSecret: true }] }), null);
  assert.equal(questionToCoucou({ id: "q3", questions: [] }), null);
});

test("observer digests become a headline; done digests are dropped", () => {
  const h = observerToCoucou({ sessionKey: "agent:sales:coucou", agentId: "sales", revision: 1, updatedAt: 0,
    headline: "Analyse le pipeline", health: "stuck", planProgress: { completed: 2, total: 5 } });
  assert.equal(h.hook_event_name, "OpenClawHeadline");
  assert.equal(h.openclaw_agent, "sales");
  assert.equal(h.headline, "⚠ Analyse le pipeline (2/5)");
  assert.equal(observerToCoucou({ digest: { sessionKey: "agent:x:y", headline: "fini", health: "done" } }), null);
  assert.equal(observerToCoucou({ digest: { sessionKey: "agent:x:y", headline: "go", health: "on-track" } }).headline, "go");
});

test("status summary: cost of the last day, failing cron jobs", () => {
  const s = statusSummary({
    health: { ok: true },
    cost: { daily: [{ totalCost: 9 }, { totalCost: 0.4242 }] },
    cron: { jobs: 20 },
    failing: { jobs: [{ displayName: "Skill review (infra)", lastRunError: "⚠️ Ls failed", lastRunAt: "2026-09-26T19:09:07Z" }] },
  });
  assert.equal(s.ok, false);
  assert.equal(s.summary, "Gateway OK · $0.42 today · 20 cron · 1 failing");
  assert.deepEqual(s.failing, ["Skill review (infra) — ⚠️ Ls failed (2026-09-26)"]);
  assert.equal(statusSummary({ health: { ok: true }, cost: {}, cron: { jobs: 3 }, failing: { jobs: [] } }).summary,
    "Gateway OK · $0.00 today · 3 cron");
});

test("history keeps the last 30 user/assistant text turns only", () => {
  const msgs = [
    { role: "user", content: "salut" },
    { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "toolCall", name: "exec" }] },
    { role: "toolResult", content: [{ type: "text", text: "raw" }] },
    { role: "assistant", content: [{ type: "text", text: "Bonjour " }, { type: "text", text: "!" }] },
  ];
  assert.deepEqual(historyTurns(msgs), [{ role: "user", text: "salut" }, { role: "assistant", text: "Bonjour !" }]);
  const many = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `m${i}` }));
  assert.equal(historyTurns(many).length, 30);
  assert.equal(historyTurns(many)[0].text, "m10");
});

test("speakable text drops markdown syntax and code blocks", async () => {
  const { speakableText } = await import("./events.mjs");
  assert.equal(
    speakableText("## Titre\n**Gras** et _italique_ avec `code`\n- point un\n```\nls -la\n```\nVoir [la doc](https://x.y)."),
    "Titre\nGras et italique avec code\npoint un\n \nVoir la doc.");
  assert.equal(speakableText("a".repeat(5000)).length, 4000);
});
