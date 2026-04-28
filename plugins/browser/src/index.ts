import {
  optionalNumber,
  optionalString,
  requireObject,
  requireString,
  startWorkerPlugin,
} from "@andy/plugin-worker";
import type { JsonObject, JsonValue } from "@andy/types";
import { Effect } from "effect";
import { writeFile } from "node:fs/promises";

const browserEnv = process.env as {
  ANDY_BROWSER_CDP_URL?: string;
};

startWorkerPlugin((request) =>
  Effect.fn("browser.handleRequest")(function* () {
    switch (request.toolName) {
      case "browser.navigate":
        return yield* navigate(request.input);
      case "browser.inspect":
        return yield* inspect(request.input);
      case "browser.click":
        return yield* click(request.input);
      case "browser.type":
        return yield* typeText(request.input);
      case "browser.screenshot":
        return yield* screenshot(request.input);
      case "browser.submit_form":
        return yield* submitForm(request.input);
      default:
        return yield* Effect.fail(
          new Error(`Unknown browser tool '${request.toolName}'.`),
        );
    }
  })(),
);

function navigate(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return withClient(input, "browser.navigate", (client, parsed) =>
    Effect.gen(function* () {
      const url = requireString(parsed, "url");
      yield* client.send("Page.enable");
      yield* client.send("Page.navigate", { url });
      yield* waitForLoad(client);
      const info = (yield* pageInfo(client)) as JsonObject;
      return { navigated: true, ...info };
    }),
  );
}

function inspect(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return withClient(input, "browser.inspect", (client) =>
    Effect.gen(function* () {
      return yield* pageInfo(client);
    }),
  );
}

function click(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return withClient(input, "browser.click", (client, parsed) =>
    Effect.gen(function* () {
      const selector = requireString(parsed, "selector");
      yield* evaluate(client, clickScript(selector), true);
      return { clicked: true, selector };
    }),
  );
}

function typeText(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return withClient(input, "browser.type", (client, parsed) =>
    Effect.gen(function* () {
      const selector = requireString(parsed, "selector");
      const text = requireString(parsed, "text");
      yield* evaluate(client, typeScript(selector, text), true);
      return { typed: true, selector, characters: text.length };
    }),
  );
}

function submitForm(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return withClient(input, "browser.submit_form", (client, parsed) =>
    Effect.gen(function* () {
      const selector = requireString(parsed, "selector");
      yield* evaluate(client, submitScript(selector), true);
      return { submitted: true, selector };
    }),
  );
}

function screenshot(input: JsonValue): Effect.Effect<JsonValue, unknown> {
  return withClient(input, "browser.screenshot", (client, parsed) =>
    Effect.gen(function* () {
      const location = yield* evaluate(client, "location.href");
      const outputPath = optionalString(parsed, "outputPath");
      const format = optionalString(parsed, "format") ?? "png";
      const quality = optionalNumber(parsed, "quality");
      const result = yield* client.send("Page.captureScreenshot", {
        format,
        ...(quality ? { quality } : {}),
        fromSurface: true,
      });
      const data = readString(result, "data");
      if (outputPath) {
        yield* Effect.tryPromise({
          try: () => writeFile(outputPath, Buffer.from(data, "base64")),
          catch: (cause) => cause,
        });
      }
      return {
        captured: true,
        url: String(location),
        format,
        bytes: Buffer.byteLength(data, "base64"),
        provenance: browserProvenance(String(location)),
        ...(outputPath ? { outputPath } : { imageBase64: data }),
      };
    }),
  );
}

function withClient(
  input: JsonValue,
  toolName: string,
  run: (
    client: CdpClient,
    parsed: Record<string, JsonValue | undefined>,
  ) => Effect.Effect<JsonValue, unknown>,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn(toolName)(function* () {
    const parsed = requireObject(input, toolName);
    const browserUrl =
      optionalString(parsed, "browserUrl") ??
      browserEnv.ANDY_BROWSER_CDP_URL ??
      "http://127.0.0.1:9222";
    assertLocalBrowserUrl(browserUrl);
    const tabId = optionalString(parsed, "tabId");
    const target = yield* resolveTarget(browserUrl, tabId);
    const client = yield* CdpClient.connect(target.webSocketDebuggerUrl);
    try {
      return yield* run(client, parsed);
    } finally {
      client.close();
    }
  })();
}

function assertLocalBrowserUrl(browserUrl: string): void {
  const parsed = new URL(browserUrl);
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("Browser CDP URL must point to localhost or 127.0.0.1.");
  }
}

interface BrowserTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

function resolveTarget(
  browserUrl: string,
  tabId: string | undefined,
): Effect.Effect<BrowserTarget, unknown> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(new URL("/json", browserUrl));
      if (!response.ok) {
        throw new Error(`CDP target list failed with ${String(response.status)}.`);
      }
      const targets = (await response.json()) as BrowserTarget[];
      const target =
        targets.find((item) => tabId && item.id === tabId) ??
        targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (!target?.webSocketDebuggerUrl) {
        throw new Error("No CDP page target is available.");
      }
      return target;
    },
    catch: (cause) => cause,
  });
}

class CdpClient {
  readonly #socket: BrowserWebSocket;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    {
      resolve(value: JsonObject): void;
      reject(cause: unknown): void;
    }
  >();

  private constructor(socket: BrowserWebSocket) {
    this.#socket = socket;
    this.#socket.onmessage = (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      const message = JSON.parse(data) as {
        id?: number;
        result?: JsonObject;
        error?: JsonObject;
      };
      if (typeof message.id !== "number") {
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
        return;
      }
      pending.resolve(message.result ?? {});
    };
    this.#socket.onerror = () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("CDP websocket error."));
      }
      this.#pending.clear();
    };
  }

  static connect(url: string): Effect.Effect<CdpClient, unknown> {
    return Effect.tryPromise({
      try: () =>
        new Promise<CdpClient>((resolve, reject) => {
          const socket = new BrowserWebSocket(url);
          socket.onopen = () => resolve(new CdpClient(socket));
          socket.onerror = () =>
            reject(new Error("Failed to connect to CDP websocket."));
        }),
      catch: (cause) => cause,
    });
  }

  send(method: string, params: JsonObject = {}): Effect.Effect<JsonObject, unknown> {
    return Effect.tryPromise({
      try: () =>
        new Promise<JsonObject>((resolve, reject) => {
          const id = this.#nextId;
          this.#nextId += 1;
          this.#pending.set(id, { resolve, reject });
          this.#socket.send(JSON.stringify({ id, method, params }));
        }),
      catch: (cause) => cause,
    });
  }

  close(): void {
    this.#socket.close();
  }
}

interface BrowserWebSocket {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

type BrowserWebSocketConstructor = new (url: string) => BrowserWebSocket;

const BrowserWebSocket = globalThis.WebSocket as unknown as BrowserWebSocketConstructor;

function waitForLoad(client: CdpClient): Effect.Effect<void, unknown> {
  return Effect.sleep("250 millis").pipe(
    Effect.zipRight(client.send("Runtime.enable")),
    Effect.asVoid,
  );
}

function pageInfo(client: CdpClient): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("browser.pageInfo")(function* () {
    const location = yield* evaluate(client, "location.href");
    const title = yield* evaluate(client, "document.title");
    const text = yield* evaluate(
      client,
      "document.body ? document.body.innerText.slice(0, 8000) : ''",
    );
    const links = yield* evaluate(
      client,
      `[...document.querySelectorAll('a[href]')].slice(0, 50).map((a) => ({ text: a.innerText.trim().slice(0, 120), href: a.href }))`,
      true,
    );
    const forms = yield* evaluate(
      client,
      `[...document.querySelectorAll('form')].slice(0, 20).map((form) => ({ id: form.id || null, name: form.getAttribute('name'), action: form.action, method: form.method }))`,
      true,
    );
    return {
      url: String(location),
      title: String(title),
      text: String(text),
      links: normalizeJson(links),
      forms: normalizeJson(forms),
      provenance: browserProvenance(String(location)),
    };
  })();
}

function browserProvenance(url: string): JsonValue {
  return [
    {
      sourceId: url,
      sourceType: "browser",
      trust: "untrusted",
      domain: readHostname(url) ?? "browser",
    },
  ];
}

function readHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function evaluate(
  client: CdpClient,
  expression: string,
  byValue = false,
): Effect.Effect<JsonValue, unknown> {
  return Effect.fn("browser.evaluate")(function* () {
    const result = yield* client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: byValue,
    });
    const value = readRemoteValue(result);
    return normalizeJson(value);
  })();
}

function readRemoteValue(result: JsonObject): unknown {
  const remote = (result as unknown as RuntimeEvaluateResult).result;
  if (typeof remote !== "object" || remote === null || Array.isArray(remote)) {
    return undefined;
  }
  const record = remote as RemoteObject;
  return "value" in record ? record.value : record.description;
}

interface RuntimeEvaluateResult {
  result?: unknown;
}

interface RemoteObject {
  value?: unknown;
  description?: unknown;
}

function clickScript(selector: string): string {
  return `
(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) throw new Error('Selector not found: ${selector.replaceAll("'", "\\'")}');
  node.click();
})()
`;
}

function typeScript(selector: string, text: string): string {
  return `
(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) throw new Error('Selector not found: ${selector.replaceAll("'", "\\'")}');
  node.focus();
  node.value = ${JSON.stringify(text)};
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
})()
`;
}

function submitScript(selector: string): string {
  return `
(() => {
  const form = document.querySelector(${JSON.stringify(selector)});
  if (!form) throw new Error('Selector not found: ${selector.replaceAll("'", "\\'")}');
  if (form.requestSubmit) form.requestSubmit();
  else form.submit();
})()
`;
}

function normalizeJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeJson(entry)]),
    );
  }
  return null;
}

function readString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string field '${key}'.`);
  }
  return value;
}
