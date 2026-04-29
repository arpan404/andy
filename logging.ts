const isProduction = process.env.NODE_ENV === "production" || process.env.BUN_ENV === "production";

type MutedConsoleMethod = "debug" | "info" | "log" | "trace" | "warn";

const mutedMethods: readonly MutedConsoleMethod[] = ["debug", "info", "log", "trace", "warn"];

export function configureRuntimeLogging(): void {
  if (!isProduction) return;

  for (const method of mutedMethods) {
    console[method] = () => {
      // Intentionally no-op in production.
    };
  }
}
