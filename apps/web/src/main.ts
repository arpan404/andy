const refresh = document.querySelector<HTMLButtonElement>("#refresh");
const runSkill = document.querySelector<HTMLButtonElement>("#runSkill");
const askAgent = document.querySelector<HTMLButtonElement>("#askAgent");
const voiceTurn = document.querySelector<HTMLButtonElement>("#voiceTurn");
const voiceStop = document.querySelector<HTMLButtonElement>("#voiceStop");

refresh?.addEventListener("click", () => void load());
runSkill?.addEventListener("click", () => void runSelectedSkill());
askAgent?.addEventListener("click", () => void runAgentRequest());
voiceTurn?.addEventListener("click", () => void runVoiceTurn());
voiceStop?.addEventListener("click", () => void stopVoice());
void load();

async function load() {
  const status = await request("/status");
  setText("#status", String(status.status ?? "unknown"));
  setText("#pluginCount", String(asArray(status.installedPlugins).length));
  setText("#skillCount", String(asArray(status.skills).length));
  setText("#approvalCount", String(asArray(status.approvals).length));
  setText("#eventCount", String(status.eventCount ?? "0"));
  setText("#traceCount", String(status.traceCount ?? "0"));
  const [events, traces] = await Promise.all([
    request("/events?limit=50"),
    request("/traces?limit=50"),
  ]);
  renderEventTimeline("#events", asRecordArray(events.events));
  renderTraceList("#traces", asRecordArray(traces.traces));
  renderLifecycleList(
    "#plugins",
    asRecordArray(status.installedPlugins),
    "pluginId",
    "plugins",
  );
  renderLifecycleList("#skills", asRecordArray(status.skills), "skillId", "skills");
  renderApprovalList("#approvals", asRecordArray(status.approvals));
}

async function runSelectedSkill() {
  const skillId = value("#skillId");
  const workflow = value("#workflow");
  const input = JSON.parse(value("#skillInput") || "{}") as unknown;
  const result = await request(`/skills/${encodeURIComponent(skillId)}/run`, {
    method: "POST",
    body: JSON.stringify({ workflow, input }),
  });
  setText("#output", JSON.stringify(result, null, 2));
}

async function runAgentRequest() {
  const skillIds = value("#askSkills")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const result = await request("/agent/run", {
    method: "POST",
    body: JSON.stringify({
      message: value("#askMessage"),
      skillIds,
      images: value("#askImage") ? [{ path: value("#askImage") }] : [],
    }),
  });
  setText("#output", JSON.stringify(result, null, 2));
}

async function runVoiceTurn() {
  const result = await request("/voice/turn", {
    method: "POST",
    body: JSON.stringify({
      text: value("#voiceText"),
      ...(value("#voiceTranscript")
        ? { transcriptPath: value("#voiceTranscript") }
        : {}),
      ...(value("#voiceName") ? { voice: value("#voiceName") } : {}),
      speak: checked("#voiceSpeak"),
    }),
  });
  setText("#output", JSON.stringify(result, null, 2));
}

async function stopVoice() {
  const result = await request("/voice/stop", {
    method: "POST",
    body: "{}",
  });
  setText("#output", JSON.stringify(result, null, 2));
}

interface DaemonStatus extends Record<string, unknown> {
  status?: unknown;
  installedPlugins?: unknown;
  skills?: unknown;
  approvals?: unknown;
  events?: unknown;
  traces?: unknown;
  eventCount?: unknown;
  traceCount?: unknown;
}

async function request(path: string, init?: RequestInit): Promise<DaemonStatus> {
  const typed = toTypedAcpRequest(path, init);
  const response = await fetch("/acp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(typed),
  });
  return (await response.json()) as DaemonStatus;
}

function toTypedAcpRequest(
  path: string,
  init?: RequestInit,
): { method: string; params: Record<string, unknown> } {
  const [pathname, queryString] = path.split("?", 2);
  const requestMethod = init?.method ?? "GET";
  const body =
    typeof init?.body === "string" && init.body.trim().length > 0
      ? (JSON.parse(init.body) as unknown)
      : undefined;
  const query = queryString
    ? Object.fromEntries(new URLSearchParams(queryString))
    : undefined;
  const params = {
    ...(query ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
  };

  if (requestMethod === "GET" && pathname === "/status") {
    return { method: "andy.status", params };
  }
  if (requestMethod === "GET" && pathname === "/events") {
    return { method: "andy.events.query", params };
  }
  if (requestMethod === "GET" && pathname === "/traces") {
    return { method: "andy.traces.query", params };
  }
  if (requestMethod === "POST" && pathname === "/agent/run") {
    return { method: "andy.agent.run", params: asRecord(body) ?? {} };
  }
  if (requestMethod === "POST" && pathname === "/voice/turn") {
    return { method: "andy.voice.turn", params: asRecord(body) ?? {} };
  }
  if (requestMethod === "POST" && pathname === "/voice/stop") {
    return { method: "andy.voice.stop", params: {} };
  }
  const skillRunMatch = (pathname ?? path).match(/^\/skills\/([^/]+)\/run$/);
  if (requestMethod === "POST" && skillRunMatch) {
    return {
      method: "andy.skills.run",
      params: {
        skillId: decodeURIComponent(skillRunMatch[1] ?? ""),
        body: asRecord(body) ?? {},
      },
    };
  }
  const lifecycleMatch = (pathname ?? path).match(
    /^\/(plugins|skills)\/([^/]+)\/(enable|disable)$/,
  );
  if (requestMethod === "POST" && lifecycleMatch) {
    const resource = lifecycleMatch[1] ?? "plugins";
    const id = decodeURIComponent(lifecycleMatch[2] ?? "");
    const action = lifecycleMatch[3] ?? "enable";
    return {
      method:
        resource === "plugins" ? "andy.plugins.setEnabled" : "andy.skills.setEnabled",
      params:
        resource === "plugins" ? { pluginId: id, action } : { skillId: id, action },
    };
  }
  const approvalMatch = (pathname ?? path).match(
    /^\/approvals\/([^/]+)\/(approve|deny)$/,
  );
  if (requestMethod === "POST" && approvalMatch) {
    return {
      method: "andy.approvals.decide",
      params: {
        approvalId: decodeURIComponent(approvalMatch[1] ?? ""),
        action: approvalMatch[2] ?? "approve",
      },
    };
  }

  throw new Error(`No typed ACP method for ${requestMethod} ${pathname ?? path}.`);
}

interface ListRecord extends Record<string, unknown> {
  id?: unknown;
  status?: unknown;
  event?: unknown;
  sequence?: unknown;
  publishedAt?: unknown;
  name?: unknown;
  traceId?: unknown;
  startedAt?: unknown;
  parentTraceId?: unknown;
  type?: unknown;
}

function renderLifecycleList(
  selector: string,
  items: readonly ListRecord[],
  idKey: string,
  apiRoot: "plugins" | "skills",
) {
  const node = document.querySelector(selector);
  if (!node) return;
  node.innerHTML = "";
  for (const item of items) {
    const id = String(item[idKey]);
    const status = String(item.status ?? "");
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div><strong>${escapeHtml(id)}</strong><small>${escapeHtml(status)}</small></div>`;
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const action of status === "enabled" ? ["disable"] : ["enable"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action;
      button.addEventListener("click", async () => {
        await request(`/${apiRoot}/${encodeURIComponent(id)}/${action}`, {
          method: "POST",
          body: "{}",
        });
        await load();
      });
      actions.append(button);
    }
    row.append(actions);
    node.append(row);
  }
}

function renderApprovalList(selector: string, items: readonly ListRecord[]) {
  const node = document.querySelector(selector);
  if (!node) return;
  node.innerHTML = "";
  for (const item of items) {
    const id = String(item.id ?? "");
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div><strong>${escapeHtml(id)}</strong><small>${escapeHtml(String(item.status ?? ""))}</small></div>`;
    if (String(item.status ?? "") === "pending") {
      const actions = document.createElement("div");
      actions.className = "actions";
      for (const action of ["approve", "deny"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action;
        button.addEventListener("click", async () => {
          await request(`/approvals/${encodeURIComponent(id)}/${action}`, {
            method: "POST",
            body: "{}",
          });
          await load();
        });
        actions.append(button);
      }
      row.append(actions);
    }
    node.append(row);
  }
}

function renderEventTimeline(selector: string, items: readonly ListRecord[]) {
  const node = document.querySelector(selector);
  if (!node) return;
  node.innerHTML = "";
  if (items.length === 0) {
    node.append(emptyState("No events recorded yet."));
    return;
  }
  for (const item of items.toReversed()) {
    const event = asRecord(item.event);
    const type = String(event?.type ?? "unknown");
    const sequence = String(item.sequence ?? "");
    const row = document.createElement("div");
    row.className = `event ${riskClass(type)}`;
    row.innerHTML = `
      <div class="event-marker">${escapeHtml(sequence)}</div>
      <div class="event-body">
        <div class="event-title">${escapeHtml(type)}</div>
        <div class="event-meta">${escapeHtml(String(item.publishedAt ?? ""))}</div>
        <pre>${escapeHtml(JSON.stringify(event ?? item, null, 2))}</pre>
      </div>
    `;
    node.append(row);
  }
}

function renderTraceList(selector: string, items: readonly ListRecord[]) {
  const node = document.querySelector(selector);
  if (!node) return;
  node.innerHTML = "";
  if (items.length === 0) {
    node.append(emptyState("No trace contexts are active or hydrated."));
    return;
  }
  for (const item of items.toReversed()) {
    const row = document.createElement("div");
    row.className = "trace";
    row.innerHTML = `
      <strong>${escapeHtml(String(item.name ?? "trace"))}</strong>
      <code>${escapeHtml(String(item.traceId ?? ""))}</code>
      <small>${escapeHtml(String(item.startedAt ?? ""))}</small>
      ${
        item.parentTraceId
          ? `<small>parent ${escapeHtml(String(item.parentTraceId))}</small>`
          : ""
      }
    `;
    node.append(row);
  }
}

function emptyState(message: string): HTMLElement {
  const node = document.createElement("p");
  node.className = "empty";
  node.textContent = message;
  return node;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecordArray(value: unknown): ListRecord[] {
  return asArray(value).filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function asRecord(value: unknown): ListRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ListRecord)
    : undefined;
}

function riskClass(type: string): string {
  if (type.includes("approval") || type.includes("policy")) {
    return "event-warn";
  }
  if (type.includes("secret") || type.includes("tool")) {
    return "event-hot";
  }
  return "event-calm";
}

function setText(selector: string, value: string) {
  const node = document.querySelector(selector);
  if (node) node.textContent = value;
}

function value(selector: string): string {
  return (
    document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value ??
    ""
  );
}

function checked(selector: string): boolean {
  return document.querySelector<HTMLInputElement>(selector)?.checked ?? false;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char] ?? char;
  });
}
