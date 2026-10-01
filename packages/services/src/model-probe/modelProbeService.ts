import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { ZCodeModelProbeConfig, ZCodeModelProbeView } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { ZCodeAgentModelProbeTarget } from "../zcode-agent/zcodeAgent.js";

export interface IModelProbeService {
  readonly onDidChange: Event<ZCodeModelProbeView>;
  getView(): Promise<ZCodeModelProbeView>;
  probeAll(config?: Partial<ZCodeModelProbeConfig>): Promise<void>;
  updateConfig(config: ZCodeModelProbeConfig): Promise<ZCodeModelProbeView>;
}

export const IModelProbeService = createServiceDescriptor<IModelProbeService>(
  ServiceChannels.ModelProbe,
);

export interface ModelProbeServiceDeps {
  /** 按 workspace 目标解析 zcodeAgent 客户端并发起协议调用（与 testModelConnectivity 同构）。 */
  request: <T>(method: string, params: unknown, parse: (value: unknown) => T) => Promise<T>;
  target: ZCodeAgentModelProbeTarget;
}

export function createModelProbeService(deps: ModelProbeServiceDeps): IModelProbeService {
  return {
    onDidChange: (listener) => ({ dispose: () => void listener }),
    // View 订阅通过 UI hook 侧轮询 getView（revision 比较）实现；
    // 协议通知面后续可加 providerModelProbeChanged，首版不引入。
    async getView() {
      return deps.request(
        "provider/modelProbeGetView",
        { workspace: deps.target },
        (value) => value as ZCodeModelProbeView,
      );
    },
    async probeAll(config) {
      await deps.request(
        "provider/modelProbeProbeAll",
        { workspace: deps.target, ...(config ? { config } : {}) },
        (value) => value as { started: boolean },
      );
    },
    async updateConfig(next) {
      return deps.request(
        "provider/modelProbeUpdateConfig",
        { workspace: deps.target, config: next },
        (value) => value as ZCodeModelProbeView,
      );
    },
  };
}
