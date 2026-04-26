import { describe, expect, test } from "bun:test";
import { createScratchFileSystem, RealFileSystem } from "./index.js";

describe("MemoryFileSystem", () => {
  test("stores scratch files in memory", async () => {
    const fs = createScratchFileSystem({
      seed: {
        "notes/input.txt": "hello",
      },
    });

    await fs.writeFile("notes/output.txt", "world");

    expect(await fs.readFile("notes/input.txt")).toBe("hello");
    expect(await fs.readFile("notes/output.txt")).toBe("world");
    expect(await fs.exists("notes/output.txt")).toBe(true);
    expect(await fs.readdir("notes")).toEqual(["input.txt", "output.txt"]);
  });

  test("prevents path escapes", async () => {
    const fs = createScratchFileSystem();

    await expect(fs.writeFile("../escape.txt", "no")).rejects.toThrow(
      "escapes virtual filesystem root",
    );
  });
});

describe("RealFileSystem", () => {
  test("prevents scoped root escapes", async () => {
    const fs = new RealFileSystem({ root: "/tmp/andy-vfs-test" });

    await expect(fs.readFile("../escape.txt")).rejects.toThrow(
      "escapes filesystem root",
    );
  });
});
