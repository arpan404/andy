const daemonUrl = document.querySelector<HTMLInputElement>("#daemonUrl");
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
}

async function request(path: string, init?: RequestInit): Promise<DaemonStatus> {
  const base = daemonUrl?.value || "http://127.0.0.1:8765";
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return (await response.json()) as DaemonStatus;
}

interface ListRecord extends Record<string, unknown> {
  id?: unknown;
  status?: unknown;
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecordArray(value: unknown): ListRecord[] {
  return asArray(value).filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
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
