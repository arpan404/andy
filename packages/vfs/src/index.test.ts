import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createScratchFileSystem, RealFileSystem } from "./index.js";

describe("MemoryFileSystem", () => {
  test("stores scratch files in memory", async () => {
    const fs = createScratchFileSystem({
      seed: {
        "notes/input.txt": "hello",
      },
    });

    await Effect.runPromise(fs.writeFile("notes/output.txt", "world"));

    expect(await Effect.runPromise(fs.readFile("notes/input.txt"))).toBe("hello");
    expect(await Effect.runPromise(fs.readFile("notes/output.txt"))).toBe("world");
    expect(await Effect.runPromise(fs.exists("notes/output.txt"))).toBe(true);
    expect(await Effect.runPromise(fs.readdir("notes"))).toEqual([
      "input.txt",
      "output.txt",
    ]);
  });

  test("prevents path escapes", async () => {
    const fs = createScratchFileSystem();

    await expect(
      Effect.runPromise(fs.writeFile("../escape.txt", "no")),
    ).rejects.toThrow("escapes virtual filesystem root");
  });
});

describe("RealFileSystem", () => {
  test("prevents scoped root escapes", async () => {
    const fs = new RealFileSystem({ root: "/tmp/andy-vfs-test" });

    await expect(Effect.runPromise(fs.readFile("../escape.txt"))).rejects.toThrow(
      "escapes filesystem root",
    );
  });
});
