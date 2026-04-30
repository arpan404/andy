import type { AuditSink } from "@andy/audit";
import { Effect } from "effect";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname } from "node:path";
import { SecretAccessDeniedError, SecretNotFoundError } from "./errors.js";

export interface SecretRequest {
  pluginId: string;
  scope: string;
  declaredScopes: ReadonlySet<string>;
}

export interface SecretReference {
  pluginId: string;
  scope: string;
  value: string;
}

export interface SecretBroker {
  set(secret: SecretReference): Effect.Effect<void, unknown>;
  rotate(secret: SecretReference): Effect.Effect<void, unknown>;
  get(
    request: SecretRequest,
  ): Effect.Effect<string, SecretAccessDeniedError | SecretNotFoundError | unknown>;
  listReferences(): readonly Omit<SecretReference, "value">[];
}

export class InMemorySecretBroker implements SecretBroker {
  readonly #audit: AuditSink;
  readonly #secrets = new Map<string, string>();

  constructor(options: { audit: AuditSink }) {
    this.#audit = options.audit;
  }

  set(secret: SecretReference): Effect.Effect<void> {
    return Effect.fn("InMemorySecretBroker.set")(() =>
      Effect.sync(() => {
        this.#secrets.set(toSecretKey(secret.pluginId, secret.scope), secret.value);
      }),
    )();
  }

  rotate(secret: SecretReference): Effect.Effect<void> {
    const self = this;
    return Effect.fn("InMemorySecretBroker.rotate")(function* () {
      yield* self.set(secret);
      yield* self.#audit.record({
        type: "secret.rotated",
        pluginId: secret.pluginId,
        scope: secret.scope,
      });
    })();
  }

  get(
    request: SecretRequest,
  ): Effect.Effect<string, SecretAccessDeniedError | SecretNotFoundError> {
    const self = this;
    return Effect.fn("InMemorySecretBroker.get")(function* () {
      yield* self.#audit.record({
        type: "secret.requested",
        pluginId: request.pluginId,
        scope: request.scope,
      });

      if (!request.declaredScopes.has(request.scope)) {
        return yield* Effect.fail(
          new SecretAccessDeniedError({
            pluginId: request.pluginId,
            scope: request.scope,
            message: `Plugin '${request.pluginId}' did not declare secret scope '${request.scope}'.`,
          }),
        );
      }

      const value = self.#secrets.get(toSecretKey(request.pluginId, request.scope));
      if (!value) {
        return yield* Effect.fail(
          new SecretNotFoundError({
            pluginId: request.pluginId,
            scope: request.scope,
            message: `Secret scope '${request.scope}' is not configured for plugin '${request.pluginId}'.`,
          }),
        );
      }

      return value;
    })();
  }

  listReferences(): readonly Omit<SecretReference, "value">[] {
    return [...this.#secrets.keys()]
      .map((key) => {
        const [pluginId, ...scopeParts] = key.split(":");
        return {
          pluginId: pluginId ?? "",
          scope: scopeParts.join(":"),
        };
      })
      .sort((a, b) =>
        `${a.pluginId}:${a.scope}`.localeCompare(`${b.pluginId}:${b.scope}`),
      );
  }
}

export class OsSecretBroker implements SecretBroker {
  readonly #audit: AuditSink;
  readonly #serviceName: string;
  readonly #fallback: JsonFileSecretBroker;
  readonly #references = new Map<string, Omit<SecretReference, "value">>();
  readonly #fallbackRecords = new Map<string, SecretReference>();

  constructor(options: {
    audit: AuditSink;
    fallbackPath: string;
    serviceName?: string;
  }) {
    this.#audit = options.audit;
    this.#serviceName = options.serviceName ?? "andy";
    this.#fallback = new JsonFileSecretBroker({
      audit: options.audit,
      path: options.fallbackPath,
    });
  }

  load(): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("OsSecretBroker.load")(function* () {
      const fallbackRecords = yield* self.#fallback.loadRecords();
      for (const secret of fallbackRecords) {
        self.#fallbackRecords.set(toSecretKey(secret.pluginId, secret.scope), secret);
        self.#remember(secret);
      }
    })();
  }

  set(secret: SecretReference): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("OsSecretBroker.set")(function* () {
      const stored = yield* Effect.either(self.#setNative(secret));
      if (stored._tag === "Left") {
        self.#fallbackRecords.set(toSecretKey(secret.pluginId, secret.scope), secret);
        yield* self.#fallback.save([...self.#fallbackRecords.values()]);
      }
      self.#remember(secret);
    })();
  }

  rotate(secret: SecretReference): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("OsSecretBroker.rotate")(function* () {
      yield* self.set(secret);
      yield* self.#audit.record({
        type: "secret.rotated",
        pluginId: secret.pluginId,
        scope: secret.scope,
      });
    })();
  }

  get(
    request: SecretRequest,
  ): Effect.Effect<string, SecretAccessDeniedError | SecretNotFoundError | unknown> {
    const self = this;
    return Effect.fn("OsSecretBroker.get")(function* () {
      yield* self.#audit.record({
        type: "secret.requested",
        pluginId: request.pluginId,
        scope: request.scope,
      });

      if (!request.declaredScopes.has(request.scope)) {
        return yield* Effect.fail(
          new SecretAccessDeniedError({
            pluginId: request.pluginId,
            scope: request.scope,
            message: `Plugin '${request.pluginId}' did not declare secret scope '${request.scope}'.`,
          }),
        );
      }

      const native = yield* Effect.either(
        self.#getNative(request.pluginId, request.scope),
      );
      if (native._tag === "Right") {
        return native.right;
      }

      return yield* self.#fallback.get(request);
    })();
  }

  listReferences(): readonly Omit<SecretReference, "value">[] {
    const references = new Map<string, Omit<SecretReference, "value">>();
    for (const reference of this.#fallback.listReferences()) {
      references.set(toSecretKey(reference.pluginId, reference.scope), reference);
    }
    for (const reference of this.#references.values()) {
      references.set(toSecretKey(reference.pluginId, reference.scope), reference);
    }
    return [...references.values()].sort((a, b) =>
      `${a.pluginId}:${a.scope}`.localeCompare(`${b.pluginId}:${b.scope}`),
    );
  }

  #remember(reference: Omit<SecretReference, "value">): void {
    this.#references.set(toSecretKey(reference.pluginId, reference.scope), {
      pluginId: reference.pluginId,
      scope: reference.scope,
    });
  }

  #setNative(secret: SecretReference): Effect.Effect<void, unknown> {
    const key = toSecretKey(secret.pluginId, secret.scope);
    switch (platform()) {
      case "darwin":
        return runCommand("security", [
          "add-generic-password",
          "-a",
          key,
          "-s",
          this.#serviceName,
          "-w",
          secret.value,
          "-U",
        ]).pipe(Effect.asVoid);
      case "linux":
        return runCommand(
          "secret-tool",
          [
            "store",
            "--label",
            `Andy ${key}`,
            "andy-service",
            this.#serviceName,
            "andy-key",
            key,
          ],
          secret.value,
        ).pipe(Effect.asVoid);
      case "win32":
        return runCommand("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          windowsCredentialScript("write", key, secret.value),
        ]).pipe(Effect.asVoid);
      default:
        return Effect.fail(new Error(`No OS secret adapter for ${platform()}.`));
    }
  }

  #getNative(pluginId: string, scope: string): Effect.Effect<string, unknown> {
    const key = toSecretKey(pluginId, scope);
    switch (platform()) {
      case "darwin":
        return runCommand("security", [
          "find-generic-password",
          "-a",
          key,
          "-s",
          this.#serviceName,
          "-w",
        ]).pipe(Effect.map((output) => output.trim()));
      case "linux":
        return runCommand("secret-tool", [
          "lookup",
          "andy-service",
          this.#serviceName,
          "andy-key",
          key,
        ]).pipe(Effect.map((output) => output.trim()));
      case "win32":
        return runCommand("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          windowsCredentialScript("read", key),
        ]).pipe(Effect.map((output) => output.trim()));
      default:
        return Effect.fail(new Error(`No OS secret adapter for ${platform()}.`));
    }
  }
}

export class JsonFileSecretBroker extends InMemorySecretBroker {
  readonly #path: string;
  readonly #audit: AuditSink;

  constructor(options: { audit: AuditSink; path: string }) {
    super({ audit: options.audit });
    this.#audit = options.audit;
    this.#path = options.path;
  }

  load(): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("JsonFileSecretBroker.load")(function* () {
      const records = yield* self.loadRecords();
      for (const secret of records) {
        yield* self.set(secret);
      }
    })();
  }

  loadRecords(): Effect.Effect<readonly SecretReference[], unknown> {
    const self = this;
    return Effect.fn("JsonFileSecretBroker.loadRecords")(function* () {
      const text = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(self.#path, "utf8");
          } catch (cause) {
            if (isFileNotFound(cause)) {
              return "[]";
            }
            throw cause;
          }
        },
        catch: (cause) => cause,
      });
      return parseSecretRecords(text);
    })();
  }

  save(records: readonly SecretReference[]): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.fn("JsonFileSecretBroker.save")(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(self.#path), { recursive: true });
          await writeFile(
            self.#path,
            JSON.stringify(records.map(encodeSecretRecord), null, 2),
            "utf8",
          );
        },
        catch: (cause) => cause,
      });
      for (const secret of records) {
        yield* self.set(secret);
      }
      yield* self.#audit.record({
        type: "secret.requested",
        pluginId: "core",
        scope: "secret_store.write",
      });
    })();
  }
}

function toSecretKey(pluginId: string, scope: string): string {
  return `${pluginId}:${scope}`;
}

function encodeSecretRecord(secret: SecretReference): SecretReference {
  return {
    ...secret,
    value: Buffer.from(secret.value, "utf8").toString("base64"),
  };
}

function parseSecretRecords(text: string): SecretReference[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((item): SecretReference[] => {
    if (
      typeof item === "object" &&
      item !== null &&
      "pluginId" in item &&
      "scope" in item &&
      "value" in item &&
      typeof item.pluginId === "string" &&
      typeof item.scope === "string" &&
      typeof item.value === "string"
    ) {
      return [
        {
          pluginId: item.pluginId,
          scope: item.scope,
          value: Buffer.from(item.value, "base64").toString("utf8"),
        },
      ];
    }

    return [];
  });
}

function isFileNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

function runCommand(
  command: string,
  args: readonly string[],
  input?: string,
): Effect.Effect<string, unknown> {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          command,
          [...args],
          { timeout: 15_000 },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr || error.message));
              return;
            }
            resolve(stdout);
          },
        );
        if (input !== undefined) {
          child.stdin?.end(input);
        }
      }),
    catch: (cause) => cause,
  });
}

function windowsCredentialScript(
  mode: "read" | "write",
  target: string,
  secret?: string,
): string {
  return `
$code = @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class AndyCredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref Credential credential, UInt32 flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
  public const UInt32 Generic = 1;
  public const UInt32 LocalMachine = 2;
  public static void Write(string target, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    IntPtr blob = Marshal.AllocCoTaskMem(bytes.Length);
    Marshal.Copy(bytes, 0, blob, bytes.Length);
    var credential = new Credential();
    credential.Type = Generic;
    credential.TargetName = target;
    credential.UserName = "andy";
    credential.CredentialBlob = blob;
    credential.CredentialBlobSize = (UInt32)bytes.Length;
    credential.Persist = LocalMachine;
    if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    Marshal.FreeCoTaskMem(blob);
  }
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, Generic, 0, out pointer)) throw new Win32Exception(Marshal.GetLastWin32Error());
    var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
    byte[] bytes = new byte[credential.CredentialBlobSize];
    Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
    CredFree(pointer);
    return Encoding.Unicode.GetString(bytes);
  }
}
"@
Add-Type -TypeDefinition $code
${mode === "write" ? `[AndyCredMan]::Write(${JSON.stringify(target)}, ${JSON.stringify(secret ?? "")})` : `[AndyCredMan]::Read(${JSON.stringify(target)})`}
`;
}
