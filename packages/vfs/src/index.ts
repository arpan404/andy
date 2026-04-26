import { constants as fsConstants } from "node:fs";
import realFs from "node:fs/promises";
import path from "node:path";
import { createFsFromVolume, Volume } from "memfs";

export interface FileStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt: Date;
}

export interface AgentFileSystem {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, contents: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
  readdir(dirPath: string): Promise<string[]>;
  stat(filePath: string): Promise<FileStat>;
  exists(filePath: string): Promise<boolean>;
  rm(filePath: string): Promise<void>;
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

  async readFile(filePath: string): Promise<string> {
    const contents = await this.#fs.readFile(this.resolve(filePath), {
      encoding: "utf8",
    });
    return String(contents);
  }

  async writeFile(filePath: string, contents: string): Promise<void> {
    const absolutePath = this.resolve(filePath);
    await this.#fs.mkdir(path.posix.dirname(absolutePath), { recursive: true });
    await this.#fs.writeFile(absolutePath, contents, { encoding: "utf8" });
  }

  async mkdir(dirPath: string): Promise<void> {
    await this.#fs.mkdir(this.resolve(dirPath), { recursive: true });
  }

  async readdir(dirPath: string): Promise<string[]> {
    const entries = await this.#fs.readdir(this.resolve(dirPath), {
      encoding: "utf8",
    });
    return entries.map((entry) => String(entry));
  }

  async stat(filePath: string): Promise<FileStat> {
    const stat = await this.#fs.stat(this.resolve(filePath));
    return {
      size: Number(stat.size),
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      modifiedAt: stat.mtime,
    };
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.#fs.access(this.resolve(filePath), fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async rm(filePath: string): Promise<void> {
    await this.#fs.rm(this.resolve(filePath), {
      force: true,
      recursive: true,
    });
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

  async readFile(filePath: string): Promise<string> {
    return realFs.readFile(this.resolve(filePath), "utf8");
  }

  async writeFile(filePath: string, contents: string): Promise<void> {
    const absolutePath = this.resolve(filePath);
    await realFs.mkdir(path.dirname(absolutePath), { recursive: true });
    await realFs.writeFile(absolutePath, contents, "utf8");
  }

  async mkdir(dirPath: string): Promise<void> {
    await realFs.mkdir(this.resolve(dirPath), { recursive: true });
  }

  async readdir(dirPath: string): Promise<string[]> {
    return realFs.readdir(this.resolve(dirPath), "utf8");
  }

  async stat(filePath: string): Promise<FileStat> {
    const stat = await realFs.stat(this.resolve(filePath));
    return {
      size: stat.size,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      modifiedAt: stat.mtime,
    };
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await realFs.access(this.resolve(filePath), fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async rm(filePath: string): Promise<void> {
    await realFs.rm(this.resolve(filePath), {
      force: true,
      recursive: true,
    });
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
