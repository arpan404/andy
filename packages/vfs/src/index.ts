import { constants as fsConstants } from "node:fs";
import realFs from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import { createFsFromVolume, Volume } from "memfs";

export interface FileStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt: Date;
}

export class FileSystemAccessError extends Schema.TaggedError<FileSystemAccessError>()(
  "FileSystemAccessError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}

export class FileSystemPathEscapeError extends Schema.TaggedError<FileSystemPathEscapeError>()(
  "FileSystemPathEscapeError",
  {
    root: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export type FileSystemError = FileSystemAccessError | FileSystemPathEscapeError;

export interface AgentFileSystem {
  readFile(filePath: string): Effect.Effect<string, FileSystemError>;
  writeFile(filePath: string, contents: string): Effect.Effect<void, FileSystemError>;
  mkdir(dirPath: string): Effect.Effect<void, FileSystemError>;
  readdir(dirPath: string): Effect.Effect<string[], FileSystemError>;
  stat(filePath: string): Effect.Effect<FileStat, FileSystemError>;
  exists(filePath: string): Effect.Effect<boolean>;
  rm(filePath: string): Effect.Effect<void, FileSystemError>;
}

export interface MemoryFileSystemOptions {
  cwd?: string;
  seed?: Record<string, string>;
}

export class MemoryFileSystem implements AgentFileSystem {
  readonly #cwd: string;
  readonly #volume: Volume;
  readonly #fs: ReturnType<typeof createFsFromVolume>["promises"];

  constructor(options: MemoryFileSystemOptions = {}) {
    this.#cwd = normalizeAbsolutePath(options.cwd ?? "/workspace");
    this.#volume = new Volume();
    this.#fs = createFsFromVolume(this.#volume).promises;
    this.#volume.mkdirSync(this.#cwd, { recursive: true });

    for (const [filePath, contents] of Object.entries(options.seed ?? {})) {
      const absolutePath = this.resolve(filePath);
      this.#volume.mkdirSync(path.posix.dirname(absolutePath), {
        recursive: true,
      });
      this.#volume.writeFileSync(absolutePath, contents, { encoding: "utf8" });
    }
  }

  resolve(filePath: string): string {
    const resolvedPath = path.posix.resolve(this.#cwd, filePath);
    if (!isWithinPath(this.#cwd, resolvedPath)) {
      throw new Error(`Path '${filePath}' escapes virtual filesystem root.`);
    }

    return resolvedPath;
  }

  readFile(filePath: string): Effect.Effect<string, FileSystemError> {
    const self = this;
    return Effect.fn("MemoryFileSystem.readFile")(function* () {
      const absolutePath = yield* resolveVirtualPath(self.#cwd, filePath);
      const contents = yield* tryFs("readFile", filePath, () =>
        self.#fs.readFile(absolutePath, { encoding: "utf8" }),
      );
      return String(contents);
    })();
  }

  writeFile(filePath: string, contents: string): Effect.Effect<void, FileSystemError> {
    const self = this;
    return Effect.fn("MemoryFileSystem.writeFile")(function* () {
      const absolutePath = yield* resolveVirtualPath(self.#cwd, filePath);
      yield* tryFs("mkdir", path.posix.dirname(absolutePath), () =>
        self.#fs.mkdir(path.posix.dirname(absolutePath), { recursive: true }),
      );
      yield* tryFs("writeFile", filePath, () =>
        self.#fs.writeFile(absolutePath, contents, { encoding: "utf8" }),
      );
    })();
  }

  mkdir(dirPath: string): Effect.Effect<void, FileSystemError> {
    const self = this;
    return Effect.fn("MemoryFileSystem.mkdir")(function* () {
      const absolutePath = yield* resolveVirtualPath(self.#cwd, dirPath);
      yield* tryFs("mkdir", dirPath, () =>
        self.#fs.mkdir(absolutePath, { recursive: true }),
      );
    })();
  }

  readdir(dirPath: string): Effect.Effect<string[], FileSystemError> {
    const self = this;
    return Effect.fn("MemoryFileSystem.readdir")(function* () {
      const absolutePath = yield* resolveVirtualPath(self.#cwd, dirPath);
      const entries = yield* tryFs("readdir", dirPath, () =>
        self.#fs.readdir(absolutePath, { encoding: "utf8" }),
      );
      return entries.map((entry) => String(entry));
    })();
  }

  stat(filePath: string): Effect.Effect<FileStat, FileSystemError> {
    const self = this;
    return Effect.fn("MemoryFileSystem.stat")(function* () {
      const absolutePath = yield* resolveVirtualPath(self.#cwd, filePath);
      const stat = yield* tryFs("stat", filePath, () => self.#fs.stat(absolutePath));
      return {
        size: Number(stat.size),
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        modifiedAt: stat.mtime,
      };
    })();
  }

  exists(filePath: string): Effect.Effect<boolean> {
    return Effect.promise(async () => {
      try {
        const absolutePath = path.posix.resolve(this.#cwd, filePath);
        if (!isWithinPath(this.#cwd, absolutePath)) {
          return false;
        }
        await this.#fs.access(absolutePath, fsConstants.F_OK);
        return true;
      } catch {
        return false;
      }
    });
  }

  rm(filePath: string): Effect.Effect<void, FileSystemError> {
    const self = this;
    return Effect.fn("MemoryFileSystem.rm")(function* () {
      const absolutePath = yield* resolveVirtualPath(self.#cwd, filePath);
      yield* tryFs("rm", filePath, () =>
        self.#fs.rm(absolutePath, {
          force: true,
          recursive: true,
        }),
      );
    })();
  }

  toJSON(): Record<string, string | null> {
    return this.#volume.toJSON(this.#cwd, {}, true);
  }
}

export interface RealFileSystemOptions {
  root: string;
}

export class RealFileSystem implements AgentFileSystem {
  readonly #root: string;

  constructor(options: RealFileSystemOptions) {
    this.#root = path.resolve(options.root);
  }

  resolve(filePath: string): string {
    const resolvedPath = path.resolve(this.#root, filePath);
    if (!isWithinPath(this.#root, resolvedPath)) {
      throw new Error(`Path '${filePath}' escapes filesystem root.`);
    }

    return resolvedPath;
  }

  readFile(filePath: string): Effect.Effect<string, FileSystemError> {
    const self = this;
    return Effect.fn("RealFileSystem.readFile")(function* () {
      const absolutePath = yield* resolveRealPath(self.#root, filePath);
      return yield* tryFs("readFile", filePath, () =>
        realFs.readFile(absolutePath, "utf8"),
      );
    })();
  }

  writeFile(filePath: string, contents: string): Effect.Effect<void, FileSystemError> {
    const self = this;
    return Effect.fn("RealFileSystem.writeFile")(function* () {
      const absolutePath = yield* resolveRealPath(self.#root, filePath);
      yield* tryFs("mkdir", path.dirname(absolutePath), () =>
        realFs.mkdir(path.dirname(absolutePath), { recursive: true }),
      );
      yield* tryFs("writeFile", filePath, () =>
        realFs.writeFile(absolutePath, contents, "utf8"),
      );
    })();
  }

  mkdir(dirPath: string): Effect.Effect<void, FileSystemError> {
    const self = this;
    return Effect.fn("RealFileSystem.mkdir")(function* () {
      const absolutePath = yield* resolveRealPath(self.#root, dirPath);
      yield* tryFs("mkdir", dirPath, () =>
        realFs.mkdir(absolutePath, { recursive: true }),
      );
    })();
  }

  readdir(dirPath: string): Effect.Effect<string[], FileSystemError> {
    const self = this;
    return Effect.fn("RealFileSystem.readdir")(function* () {
      const absolutePath = yield* resolveRealPath(self.#root, dirPath);
      return yield* tryFs("readdir", dirPath, () =>
        realFs.readdir(absolutePath, "utf8"),
      );
    })();
  }

  stat(filePath: string): Effect.Effect<FileStat, FileSystemError> {
    const self = this;
    return Effect.fn("RealFileSystem.stat")(function* () {
      const absolutePath = yield* resolveRealPath(self.#root, filePath);
      const stat = yield* tryFs("stat", filePath, () => realFs.stat(absolutePath));
      return {
        size: stat.size,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        modifiedAt: stat.mtime,
      };
    })();
  }

  exists(filePath: string): Effect.Effect<boolean> {
    return Effect.promise(async () => {
      try {
        const absolutePath = path.resolve(this.#root, filePath);
        if (!isWithinPath(this.#root, absolutePath)) {
          return false;
        }
        await realFs.access(absolutePath, fsConstants.F_OK);
        return true;
      } catch {
        return false;
      }
    });
  }

  rm(filePath: string): Effect.Effect<void, FileSystemError> {
    const self = this;
    return Effect.fn("RealFileSystem.rm")(function* () {
      const absolutePath = yield* resolveRealPath(self.#root, filePath);
      yield* tryFs("rm", filePath, () =>
        realFs.rm(absolutePath, {
          force: true,
          recursive: true,
        }),
      );
    })();
  }
}

export function createScratchFileSystem(
  options?: MemoryFileSystemOptions,
): MemoryFileSystem {
  return new MemoryFileSystem(options);
}

function normalizeAbsolutePath(filePath: string): string {
  return path.posix.resolve("/", filePath);
}

function isWithinPath(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function resolveVirtualPath(
  root: string,
  filePath: string,
): Effect.Effect<string, FileSystemPathEscapeError> {
  return Effect.sync(() => path.posix.resolve(root, filePath)).pipe(
    Effect.flatMap((candidate) =>
      isWithinPath(root, candidate)
        ? Effect.succeed(candidate)
        : Effect.fail(
            new FileSystemPathEscapeError({
              root,
              path: filePath,
              message: `Path '${filePath}' escapes virtual filesystem root.`,
            }),
          ),
    ),
  );
}

function resolveRealPath(
  root: string,
  filePath: string,
): Effect.Effect<string, FileSystemPathEscapeError> {
  return Effect.sync(() => path.resolve(root, filePath)).pipe(
    Effect.flatMap((candidate) =>
      isWithinPath(root, candidate)
        ? Effect.succeed(candidate)
        : Effect.fail(
            new FileSystemPathEscapeError({
              root,
              path: filePath,
              message: `Path '${filePath}' escapes filesystem root.`,
            }),
          ),
    ),
  );
}

function tryFs<A>(
  operation: string,
  filePath: string,
  run: () => Promise<A>,
): Effect.Effect<A, FileSystemAccessError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new FileSystemAccessError({
        operation,
        path: filePath,
        message: `Filesystem operation '${operation}' failed for '${filePath}'.`,
        cause: stringifyCause(cause),
      }),
  });
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
