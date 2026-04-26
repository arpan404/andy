import type { ToolExecutionError } from "@andy/plugin-sdk";
import { Schema } from "effect";

export class PluginRegistrationError extends Schema.TaggedError<PluginRegistrationError>()(
  "PluginRegistrationError",
  {
    pluginId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}

export class ToolAlreadyRegisteredError extends Schema.TaggedError<ToolAlreadyRegisteredError>()(
  "ToolAlreadyRegisteredError",
  {
    pluginId: Schema.String,
    toolName: Schema.String,
    message: Schema.String,
  },
) {}

export class ToolNameAmbiguousError extends Schema.TaggedError<ToolNameAmbiguousError>()(
  "ToolNameAmbiguousError",
  {
    toolName: Schema.String,
    matches: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export class ToolNotRegisteredError extends Schema.TaggedError<ToolNotRegisteredError>()(
  "ToolNotRegisteredError",
  {
    toolName: Schema.String,
    message: Schema.String,
  },
) {}

export class ToolPolicyDeniedError extends Schema.TaggedError<ToolPolicyDeniedError>()(
  "ToolPolicyDeniedError",
  {
    toolName: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export class ToolApprovalRequiredError extends Schema.TaggedError<ToolApprovalRequiredError>()(
  "ToolApprovalRequiredError",
  {
    approvalId: Schema.String,
    toolName: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export class PluginNotRegisteredError extends Schema.TaggedError<PluginNotRegisteredError>()(
  "PluginNotRegisteredError",
  {
    pluginId: Schema.String,
    message: Schema.String,
  },
) {}

export class PluginDisabledError extends Schema.TaggedError<PluginDisabledError>()(
  "PluginDisabledError",
  {
    pluginId: Schema.String,
    message: Schema.String,
  },
) {}

export class LlmRunnerError extends Schema.TaggedError<LlmRunnerError>()(
  "LlmRunnerError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}

export class AgentToolLimitExceededError extends Schema.TaggedError<AgentToolLimitExceededError>()(
  "AgentToolLimitExceededError",
  {
    sessionId: Schema.String,
    limit: Schema.Number,
    message: Schema.String,
  },
) {}

export class AgentToolInputInvalidError extends Schema.TaggedError<AgentToolInputInvalidError>()(
  "AgentToolInputInvalidError",
  {
    sessionId: Schema.String,
    toolName: Schema.String,
    message: Schema.String,
  },
) {}

export class ApprovalNotFoundError extends Schema.TaggedError<ApprovalNotFoundError>()(
  "ApprovalNotFoundError",
  {
    approvalId: Schema.String,
    message: Schema.String,
  },
) {}

export class ApprovalAlreadyResolvedError extends Schema.TaggedError<ApprovalAlreadyResolvedError>()(
  "ApprovalAlreadyResolvedError",
  {
    approvalId: Schema.String,
    status: Schema.String,
    message: Schema.String,
  },
) {}

export class PluginHostUnsupportedError extends Schema.TaggedError<PluginHostUnsupportedError>()(
  "PluginHostUnsupportedError",
  {
    pluginId: Schema.String,
    executionMode: Schema.String,
    message: Schema.String,
  },
) {}

export class PluginInstallError extends Schema.TaggedError<PluginInstallError>()(
  "PluginInstallError",
  {
    source: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}

export class SecretAccessDeniedError extends Schema.TaggedError<SecretAccessDeniedError>()(
  "SecretAccessDeniedError",
  {
    pluginId: Schema.String,
    scope: Schema.String,
    message: Schema.String,
  },
) {}

export class SecretNotFoundError extends Schema.TaggedError<SecretNotFoundError>()(
  "SecretNotFoundError",
  {
    pluginId: Schema.String,
    scope: Schema.String,
    message: Schema.String,
  },
) {}

export class SwarmLimitExceededError extends Schema.TaggedError<SwarmLimitExceededError>()(
  "SwarmLimitExceededError",
  {
    maxAgents: Schema.Number,
    requestedAgents: Schema.Number,
    message: Schema.String,
  },
) {}

export class SwarmDepthExceededError extends Schema.TaggedError<SwarmDepthExceededError>()(
  "SwarmDepthExceededError",
  {
    maxDepth: Schema.Number,
    requestedDepth: Schema.Number,
    message: Schema.String,
  },
) {}

export class SwarmRoleDeniedError extends Schema.TaggedError<SwarmRoleDeniedError>()(
  "SwarmRoleDeniedError",
  {
    role: Schema.String,
    message: Schema.String,
  },
) {}

export type AgentRuntimeError =
  | PluginRegistrationError
  | ToolAlreadyRegisteredError
  | ToolNameAmbiguousError
  | ToolNotRegisteredError
  | ToolPolicyDeniedError
  | ToolApprovalRequiredError
  | PluginNotRegisteredError
  | PluginDisabledError
  | ToolExecutionError;
