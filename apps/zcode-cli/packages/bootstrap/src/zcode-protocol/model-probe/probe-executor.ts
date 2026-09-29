// apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-probe/probe-executor.ts
import type { ZCodeProtocolAgentServerContext } from "../server-types.js";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import type { ModelProbeProbeExecutor } from "./model-probe-engine.js";
import { probeProviderModelHealth } from "../workspace-model-runtime.js";

export function createWorkspaceProbeExecutor(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): ModelProbeProbeExecutor {
  return async (input) =>
    probeProviderModelHealth(context, {
      workspace,
      selection: { providerId: input.providerId, modelId: input.modelId } as never,
    });
}
