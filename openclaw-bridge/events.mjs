// Pure Gateway → Coucou mappings (no I/O), shared by bridge.mjs and covered by events.test.mjs.

export const agentOf = (p) => p.agentId ?? /^agent:([^:]+):/.exec(p.sessionKey ?? "")?.[1] ?? "main";

// openclaw_agent → one pill per Gateway agent in Coucou (events without it go to the OpenClaw pill).
export const coucouBase = (p) => ({ session_id: p.sessionKey, cwd: `/openclaw/${agentOf(p)}`, openclaw_agent: agentOf(p) });

// OpenClaw tool ids → names Coucou already knows how to label (frenchStep).
export const TOOL_NAMES = { exec: "Bash", read: "Read", write: "Write", edit: "Edit", apply_patch: "Edit",
  web_fetch: "WebFetch", web_search: "WebSearch", spawn_agent: "Task", ls: "LS", grep: "Grep", glob: "Glob", find: "Glob" };

/** `agent` / `session.tool` event → Coucou hook payload, or null to ignore. */
export function agentEventToCoucou(p) {
  if (!p?.sessionKey || p.isHeartbeat) return null;
  const d = p.data ?? {};
  if (p.stream === "lifecycle") {
    const name = { start: "UserPromptSubmit", end: "Stop", error: "StopFailure" }[d.phase];
    return name ? { ...coucouBase(p), hook_event_name: name } : null;
  }
  if (p.stream === "tool") {
    const tool_name = TOOL_NAMES[d.name] ?? d.name ?? "Tool";
    const tool_input = d.args ?? {};
    if (d.phase === "start") return { ...coucouBase(p), hook_event_name: "PreToolUse", tool_name, tool_input };
    if (d.phase === "result") {
      return { ...coucouBase(p), hook_event_name: d.isError ? "PostToolUseFailure" : "PostToolUse", tool_name, tool_input };
    }
  }
  return null;
}

/** `exec|plugin.approval.requested` → PermissionRequest payload (without hook_event_name), or null. */
export function approvalToCoucou(kind, p) {
  if (!p?.id) return null;
  const r = p.request ?? {};
  const agent = r.agentId ?? agentOf(r);
  return {
    session_id: r.sessionKey ?? p.id,
    cwd: `/openclaw/${agent}`,
    openclaw_agent: agent,
    tool_name: kind === "exec" ? "Bash" : (r.toolName ?? "Plugin"),
    tool_input: kind === "exec"
      ? { command: r.command ?? r.commandPreview ?? "(command)" }
      : { command: [r.title, r.description].filter(Boolean).join(" — ") || "Plugin approval" },
  };
}

/** Coucou's answer → Gateway decision, or undefined to leave the approval to other surfaces. */
export const approvalDecision = (answer) => ({ allow: "allow-once", always: "allow-always", deny: "deny" })[answer];

// Secret questions (API keys…) stay in OpenClaw's own UI — never route secrets through the notch.
// ponytail: multiSelect is answered with one choice and "Other" free text only when there are no options.
export function questionToCoucou(p) {
  const qs = p?.questions ?? [];
  if (!p?.id || !qs.length || qs.some((q) => q.isSecret)) return null;
  const agent = p.agentId ?? agentOf(p);
  return {
    hook_event_name: "OpenClawQuestion",
    session_id: p.sessionKey ?? p.id,
    cwd: `/openclaw/${agent}`,
    openclaw_agent: agent,
    question: {
      id: p.id,
      items: qs.map((q) => ({ id: q.questionId, text: q.question, options: (q.options ?? []).map((o) => o.label) })),
    },
  };
}

/** `session.observer` digest → live headline for the agent's pill, or null. */
export function observerToCoucou(p) {
  const d = p?.digest ?? p;
  if (!d?.sessionKey || !d.headline || d.health === "done") return null;
  const flag = { stuck: "⚠ ", "waiting-on-user": "⏸ ", failed: "✕ " }[d.health] ?? "";
  const plan = d.planProgress?.total ? ` (${d.planProgress.completed}/${d.planProgress.total})` : "";
  return { ...coucouBase(d), hook_event_name: "OpenClawHeadline", headline: `${flag}${d.headline}${plan}` };
}

/** health + usage.cost + cron.status + failing cron.list → OpenClaw pill status. */
export function statusSummary({ health, cost, cron, failing }) {
  const today = cost?.daily?.at(-1)?.totalCost ?? 0; // daily is oldest → newest, last entry = today
  const jobs = failing?.jobs ?? [];
  return {
    ok: Boolean(health?.ok) && jobs.length === 0,
    summary: [
      health?.ok ? "Gateway OK" : "Gateway unhealthy",
      `$${today.toFixed(2)} today`,
      `${cron?.jobs ?? 0} cron` + (jobs.length ? ` · ${jobs.length} failing` : ""),
    ].join(" · "),
    failing: jobs.map((j) =>
      `${j.displayName ?? j.name} — ${j.lastRunError ?? "error"}` + (j.lastRunAt ? ` (${j.lastRunAt.slice(0, 10)})` : "")),
  };
}

export function textOf(message) {
  if (typeof message === "string") return message;
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === "text").map((b) => b.text).join("");
  return "";
}

/** chat.history messages → last 30 user/assistant text turns (thinking / tool-call-only turns dropped). */
export const historyTurns = (messages = []) => messages
  .filter((m) => m.role === "user" || m.role === "assistant")
  .map((m) => ({ role: m.role, text: textOf(m).trim() }))
  .filter((m) => m.text)
  .slice(-30);
