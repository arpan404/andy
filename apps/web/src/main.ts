const daemonUrl = document.querySelector<HTMLInputElement>("#daemonUrl");
const refresh = document.querySelector<HTMLButtonElement>("#refresh");
const runSkill = document.querySelector<HTMLButtonElement>("#runSkill");

refresh?.addEventListener("click", () => void load());
runSkill?.addEventListener("click", () => void runSelectedSkill());
void load();

async function load() {
  const status = await request("/status");
  setText("#status", String(status.status ?? "unknown"));
  setText("#pluginCount", String(asArray(status.installedPlugins).length));
  setText("#skillCount", String(asArray(status.skills).length));
  setText("#approvalCount", String(asArray(status.approvals).length));
  renderList("#plugins", asRecordArray(status.installedPlugins), "pluginId");
  renderList("#skills", asRecordArray(status.skills), "skillId");
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
  status?: unknown;
}

function renderList(selector: string, items: readonly ListRecord[], idKey: string) {
  const node = document.querySelector(selector);
  if (!node) return;
  node.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<strong>${escapeHtml(String(item[idKey]))}</strong><small>${escapeHtml(String(item.status ?? ""))}</small>`;
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
