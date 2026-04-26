import { ConsoleAuditSink } from "@andy/audit";
import { definePlugin, defineTool } from "@andy/plugin-sdk";
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";
import { AgentKernel } from "./agent-kernel.js";
import {
  createFakeAiTextResult,
  createFakeAiToolCall,
  FakeLlmRunner,
} from "./llm-test-helpers.js";
import { createRuntime, registerMemorySavePlugin } from "./test-helpers.js";
import type { AiTextGenerationResult, LlmRequest, LlmRunner } from "./types.js";
import type { LlmRunnerError } from "./errors.js";
import { AgentSessionStore } from "./session-store.js";

describe("AgentKernel", () => {
  test("runs model-planned tool calls through the runtime", async () => {
    const runtime = createRuntime(["memory.save"]);
    registerMemorySavePlugin(runtime);
    const audit = new ConsoleAuditSink();
    const agent = new AgentKernel({
      runtime,
      audit,
      llm: new FakeLlmRunner([
        createFakeAiTextResult({
          toolCalls: [
            createFakeAiToolCall("memory.save", {
              scope: "agent",
              namespace: "test",
              key: "preference",
              value: "typed kernels",
            }),
          ],
        }),
        createFakeAiTextResult({ text: "Saved." }),
      ]),
    });

    const result = await Effect.runPromise(
      agent.run({
        userMessage: "Remember that I prefer typed kernels.",
      }),
    );

    expect(result.response).toBe("Saved.");
    expect(result.toolResults).toHaveLength(1);
    expect(result.session.messages.at(-1)?.content).toBe("Saved.");
  });

  test("enforces agent tool call limits", async () => {
    const runtime = createRuntime(["memory.save"]);
    registerMemorySavePlugin(runtime);
    const agent = new AgentKernel({
      runtime,
      audit: new ConsoleAuditSink(),
      llm: new FakeLlmRunner([
        createFakeAiTextResult({
          toolCalls: [
            createFakeAiToolCall("memory.save", {}),
            createFakeAiToolCall("memory.save", {}),
          ],
        }),
      ]),
    });

    const result = await Effect.runPromiseExit(
      agent.run({ userMessage: "use too many tools", maxToolCalls: 1 }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("AgentToolLimitExceededError");
    }
  });

  test("persists and resumes sessions through a session store", async () => {
    const runtime = createRuntime([]);
    const sessions = new AgentSessionStore();
    const first = new AgentKernel({
      runtime,
      sessionStore: sessions,
      audit: new ConsoleAuditSink(),
      llm: new FakeLlmRunner([createFakeAiTextResult({ text: "First." })]),
    });
    await Effect.runPromise(
      first.run({
        sessionId: "session-1",
        userMessage: "hello",
      }),
    );

    const second = new AgentKernel({
      runtime,
      sessionStore: sessions,
      audit: new ConsoleAuditSink(),
      llm: new FakeLlmRunner([createFakeAiTextResult({ text: "Second." })]),
    });
    const result = await Effect.runPromise(
      second.run({
        sessionId: "session-1",
        userMessage: "again",
      }),
    );

    expect(sessions.list()).toHaveLength(1);
    expect(
      result.session.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
    expect(result.response).toBe("Second.");
  });

  test("executes same-step tool calls in parallel and preserves result order", async () => {
    const runtime = createRuntime(["test.slow"]);
    const completions: string[] = [];
    Effect.runSync(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.test.parallel",
          name: "Parallel Test",
          version: "0.1.0",
          capabilities: ["test.slow"],
          tools: [
            defineTool({
              name: "test.slow",
              description: "Delay before returning.",
              capabilities: ["test.slow"],
              risk: "low",
              execute(input) {
                const label = readLabel(input);
                const delayMs = label === "first" ? 40 : 5;

                return Effect.sleep(`${delayMs} millis`).pipe(
                  Effect.as({ label }),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      completions.push(label);
                    }),
                  ),
                );
              },
            }),
          ],
        }),
      ),
    );
    const agent = new AgentKernel({
      runtime,
      audit: new ConsoleAuditSink(),
      llm: new FakeLlmRunner([
        createFakeAiTextResult({
          toolCalls: [
            createFakeAiToolCall("test.slow", { label: "first" }, "call-first"),
            createFakeAiToolCall("test.slow", { label: "second" }, "call-second"),
          ],
        }),
        createFakeAiTextResult({ text: "Done." }),
      ]),
    });

    const result = await Effect.runPromise(
      agent.run({
        userMessage: "run both",
        maxParallelToolCalls: 2,
      }),
    );

    expect(completions).toEqual(["second", "first"]);
    expect(result.toolResults.map((item) => item.output)).toEqual([
      { label: "first" },
      { label: "second" },
    ]);
    expect(result.session.messages.at(-2)).toMatchObject({
      role: "tool",
      content: [
        {
          toolCallId: "call-first",
          toolName: "test.slow",
          output: { type: "json", value: { label: "first" } },
        },
        {
          toolCallId: "call-second",
          toolName: "test.slow",
          output: { type: "json", value: { label: "second" } },
        },
      ],
    });
  });

  test("honors max parallel tool call concurrency", async () => {
    const runtime = createRuntime(["test.slow"]);
    const completions: string[] = [];
    Effect.runSync(
      runtime.registerPlugin(
        definePlugin({
          id: "andy.test.serial",
          name: "Serial Test",
          version: "0.1.0",
          capabilities: ["test.slow"],
          tools: [
            defineTool({
              name: "test.slow",
              description: "Delay before returning.",
              capabilities: ["test.slow"],
              risk: "low",
              execute(input) {
                const label = readLabel(input);

                return Effect.sleep("5 millis").pipe(
                  Effect.as({ label }),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      completions.push(label);
                    }),
                  ),
                );
              },
            }),
          ],
        }),
      ),
    );
    const agent = new AgentKernel({
      runtime,
      audit: new ConsoleAuditSink(),
      llm: new FakeLlmRunner([
        createFakeAiTextResult({
          toolCalls: [
            createFakeAiToolCall("test.slow", { label: "first" }),
            createFakeAiToolCall("test.slow", { label: "second" }),
          ],
        }),
        createFakeAiTextResult({ text: "Done." }),
      ]),
    });

    await Effect.runPromise(
      agent.run({
        userMessage: "run serially",
        maxParallelToolCalls: 1,
      }),
    );

    expect(completions).toEqual(["first", "second"]);
  });

  test("fails a parallel batch when one tool call input is not JSON", async () => {
    const runtime = createRuntime(["memory.save"]);
    registerMemorySavePlugin(runtime);
    const agent = new AgentKernel({
      runtime,
      audit: new ConsoleAuditSink(),
      llm: new FakeLlmRunner([
        createFakeAiTextResult({
          toolCalls: [
            createFakeAiToolCall("memory.save", {}),
            createFakeAiToolCall("memory.save", undefined),
          ],
        }),
      ]),
    });

    const result = await Effect.runPromiseExit(
      agent.run({ userMessage: "invalid input" }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("AgentToolInputInvalidError");
    }
  });

  test("shows agents fully qualified names for duplicate plugin tools", async () => {
    const runtime = createRuntime(["memory.save"]);
    registerMemorySavePlugin(runtime, "andy.memory.markdown");
    registerMemorySavePlugin(runtime, "andy.memory.persistent");
    const agent = new AgentKernel({
      runtime,
      audit: new ConsoleAuditSink(),
      llm: new AssertingLlmRunner((request, callCount) => {
        if (callCount > 1) {
          return createFakeAiTextResult({
            text: "Saved in persistent memory.",
          });
        }

        expect(request.tools.map((tool) => tool.name)).toEqual([
          "andy.memory.markdown.memory.save",
          "andy.memory.persistent.memory.save",
        ]);
        expect(request.tools.every((tool) => tool.isLocalNameAmbiguous)).toBe(true);

        return createFakeAiTextResult({
          toolCalls: [createFakeAiToolCall("andy.memory.persistent.memory.save", {})],
        });
      }),
    });

    const result = await Effect.runPromise(
      agent.run({
        userMessage: "Remember this using the persistent memory plugin.",
      }),
    );

    expect(result.response).toBe("Saved in persistent memory.");
    expect(result.toolResults).toHaveLength(1);
  });
});

class AssertingLlmRunner implements LlmRunner {
  readonly #complete: (
    request: LlmRequest,
    callCount: number,
  ) => AiTextGenerationResult;
  #callCount = 0;

  constructor(
    complete: (request: LlmRequest, callCount: number) => AiTextGenerationResult,
  ) {
    this.#complete = complete;
  }

  complete(request: LlmRequest): Effect.Effect<AiTextGenerationResult, LlmRunnerError> {
    return Effect.fn("AssertingLlmRunner.complete")(() =>
      Effect.sync(() => {
        this.#callCount += 1;
        return this.#complete(request, this.#callCount);
      }),
    )();
  }
}

function readLabel(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "label" in input &&
    typeof input.label === "string"
  ) {
    return input.label;
  }

  return "unknown";
}
