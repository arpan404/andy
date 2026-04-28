import { Effect } from "effect";

export type EvalSuiteCategory =
  | "email_triage"
  | "calendar_scheduling"
  | "browser_booking"
  | "file_organization"
  | "coding_task_delegation"
  | "multi_step_research"
  | "desktop_control"
  | "voice_interaction"
  | "memory_recall"
  | "background_reminders"
  | "security_refusal"
  | "prompt_injection_resistance"
  | "tool_failure_recovery";

export type EvalRiskLevel = "low" | "medium" | "high" | "critical";

export type EvalInput =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly path: string; readonly mediaType?: string }
  | { readonly type: "audio"; readonly path: string; readonly mediaType?: string }
  | { readonly type: "fixture"; readonly name: string; readonly value: unknown };

export interface EvalExpectedOutcome {
  readonly description: string;
  readonly requiredArtifacts?: readonly string[];
  readonly forbiddenActions?: readonly string[];
  readonly approvalRequirements?: readonly string[];
}

export interface EvalCase {
  readonly id: string;
  readonly title: string;
  readonly category: EvalSuiteCategory;
  readonly risk: EvalRiskLevel;
  readonly inputs: readonly EvalInput[];
  readonly expected: EvalExpectedOutcome;
  readonly tags?: readonly string[];
  readonly timeoutMs?: number;
}

export interface EvalSuite {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly cases: readonly EvalCase[];
}

export interface EvalMetrics {
  readonly taskSuccess: boolean;
  readonly timeToCompletionMs: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly estimatedCostUsd: number;
  readonly latencyMs: number;
  readonly approvalCorrectness: number;
  readonly unsafeActionRate: number;
  readonly userInterventionCount: number;
  readonly recoveryQuality: number;
}

export interface EvalEvidence {
  readonly summary: string;
  readonly artifacts?: readonly string[];
  readonly notes?: readonly string[];
}

export interface EvalCaseResult {
  readonly caseId: string;
  readonly title: string;
  readonly category: EvalSuiteCategory;
  readonly passed: boolean;
  readonly metrics: EvalMetrics;
  readonly evidence: EvalEvidence;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface EvalSuiteSummary {
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly passRate: number;
  readonly averageTimeToCompletionMs: number;
  readonly totalModelCalls: number;
  readonly totalToolCalls: number;
  readonly totalEstimatedCostUsd: number;
  readonly averageUnsafeActionRate: number;
  readonly averageApprovalCorrectness: number;
  readonly averageRecoveryQuality: number;
  readonly totalUserInterventions: number;
}

export interface EvalSuiteRunResult {
  readonly suiteId: string;
  readonly title: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly results: readonly EvalCaseResult[];
  readonly summary: EvalSuiteSummary;
}

export interface EvalRunnerContext {
  readonly suiteId: string;
  readonly case: EvalCase;
}

export type EvalCaseRunner<R = never, E = never> = (
  context: EvalRunnerContext,
) => Effect.Effect<
  | EvalCaseResult
  | Omit<EvalCaseResult, "caseId" | "title" | "category" | "startedAt" | "completedAt">,
  E,
  R
>;

export const zeroEvalMetrics = (overrides: Partial<EvalMetrics> = {}): EvalMetrics => ({
  taskSuccess: false,
  timeToCompletionMs: 0,
  modelCalls: 0,
  toolCalls: 0,
  estimatedCostUsd: 0,
  latencyMs: 0,
  approvalCorrectness: 0,
  unsafeActionRate: 0,
  userInterventionCount: 0,
  recoveryQuality: 0,
  ...overrides,
});

export const createEvalSuiteSummary = (
  results: readonly EvalCaseResult[],
): EvalSuiteSummary => {
  const totalCases = results.length;
  const passedCases = results.filter((result) => result.passed).length;
  const failedCases = totalCases - passedCases;
  const totals = results.reduce(
    (accumulator, result) => ({
      timeToCompletionMs:
        accumulator.timeToCompletionMs + result.metrics.timeToCompletionMs,
      modelCalls: accumulator.modelCalls + result.metrics.modelCalls,
      toolCalls: accumulator.toolCalls + result.metrics.toolCalls,
      estimatedCostUsd: accumulator.estimatedCostUsd + result.metrics.estimatedCostUsd,
      unsafeActionRate: accumulator.unsafeActionRate + result.metrics.unsafeActionRate,
      approvalCorrectness:
        accumulator.approvalCorrectness + result.metrics.approvalCorrectness,
      recoveryQuality: accumulator.recoveryQuality + result.metrics.recoveryQuality,
      userInterventionCount:
        accumulator.userInterventionCount + result.metrics.userInterventionCount,
    }),
    {
      timeToCompletionMs: 0,
      modelCalls: 0,
      toolCalls: 0,
      estimatedCostUsd: 0,
      unsafeActionRate: 0,
      approvalCorrectness: 0,
      recoveryQuality: 0,
      userInterventionCount: 0,
    },
  );
  const divisor = totalCases === 0 ? 1 : totalCases;

  return {
    totalCases,
    passedCases,
    failedCases,
    passRate: totalCases === 0 ? 0 : passedCases / totalCases,
    averageTimeToCompletionMs: totals.timeToCompletionMs / divisor,
    totalModelCalls: totals.modelCalls,
    totalToolCalls: totals.toolCalls,
    totalEstimatedCostUsd: totals.estimatedCostUsd,
    averageUnsafeActionRate: totals.unsafeActionRate / divisor,
    averageApprovalCorrectness: totals.approvalCorrectness / divisor,
    averageRecoveryQuality: totals.recoveryQuality / divisor,
    totalUserInterventions: totals.userInterventionCount,
  };
};

export const runEvalSuite = <R, E>(
  suite: EvalSuite,
  runner: EvalCaseRunner<R, E>,
): Effect.Effect<EvalSuiteRunResult, E, R> =>
  Effect.gen(function* () {
    const startedAt = new Date().toISOString();
    const results: EvalCaseResult[] = [];

    for (const testCase of suite.cases) {
      const caseStartedAt = new Date().toISOString();
      const rawResult = yield* runner({ suiteId: suite.id, case: testCase });
      const completedAt = new Date().toISOString();
      const normalized = normalizeCaseResult(
        testCase,
        rawResult,
        caseStartedAt,
        completedAt,
      );
      results.push(normalized);
    }

    return {
      suiteId: suite.id,
      title: suite.title,
      startedAt,
      completedAt: new Date().toISOString(),
      results,
      summary: createEvalSuiteSummary(results),
    };
  });

const normalizeCaseResult = (
  testCase: EvalCase,
  rawResult:
    | EvalCaseResult
    | Omit<
        EvalCaseResult,
        "caseId" | "title" | "category" | "startedAt" | "completedAt"
      >,
  startedAt: string,
  completedAt: string,
): EvalCaseResult => {
  if ("caseId" in rawResult) {
    return rawResult;
  }

  return {
    caseId: testCase.id,
    title: testCase.title,
    category: testCase.category,
    passed: rawResult.passed,
    metrics: rawResult.metrics,
    evidence: rawResult.evidence,
    startedAt,
    completedAt,
  };
};

export const defineEvalSuite = (suite: EvalSuite): EvalSuite => suite;
