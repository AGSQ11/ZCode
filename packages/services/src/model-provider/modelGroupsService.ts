import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  ExecutionTarget,
  ModelGroup,
  ModelGroupsConfig,
  WorkloadLevel,
} from "@zcode/shared/model-group-types";
import { createServiceDescriptor } from "../descriptors.js";
import type { ProviderConfigService } from "@zcode/provider";

function toEvent<T>(subscribe: (listener: (event: T) => void) => () => void): Event<T> {
  return (listener: (event: T) => void) => {
    const dispose = subscribe(listener);
    return { dispose };
  };
}

export interface IModelGroupsService {
  readonly onDidChange: Event<ModelGroupsConfig>;
  getConfig(): Promise<ModelGroupsConfig>;
  saveConfig(config: ModelGroupsConfig, expectedRevision?: number): Promise<ModelGroupsConfig>;
  saveGroup(group: ModelGroup, expectedGroupRevision?: number): Promise<ModelGroupsConfig>;
  deleteGroup(groupId: string, replacementGroupId?: string): Promise<ModelGroupsConfig>;
  duplicateGroup(sourceGroupId: string, newId: string): Promise<ModelGroupsConfig>;
  setDefaultTarget(target: ExecutionTarget | undefined): Promise<ModelGroupsConfig>;
  setWorkloadDefault(level: WorkloadLevel, groupId: string | undefined): Promise<ModelGroupsConfig>;
}

export const IModelGroupsService = createServiceDescriptor<IModelGroupsService>(
  ServiceChannels.ModelGroups,
);

export function createModelGroupsService(
  configService: ProviderConfigService,
  ensureReady: () => Promise<void> = async () => {},
): IModelGroupsService {
  // 通知串行化（P1）：config-change 事件各自并发发起读取时，旧读可能晚于新读
  // 解析并发布过期快照，订阅方停留在陈旧状态。链式追加保证通知按发起顺序投递。
  let notifyChain: Promise<void> = Promise.resolve();
  const notify = (listener: (config: ModelGroupsConfig) => void): void => {
    notifyChain = notifyChain
      .then(async () => {
        const config = await configService.getModelGroupsConfig();
        listener(config);
      })
      .catch(() => {
        // 瞬时读取失败不阻断后续通知
      });
  };

  return {
    onDidChange: toEvent((listener) =>
      configService.onDidChange(() => notify(listener)),
    ),
    getConfig: async () => {
      await ensureReady();
      return configService.getModelGroupsConfig();
    },
    saveConfig: async (config, expectedRevision) => {
      await ensureReady();
      const snapshot = await configService.saveModelGroupsConfig(config, expectedRevision);
      return snapshot.modelGroups ?? config;
    },
    saveGroup: async (group, expectedGroupRevision) => {
      await ensureReady();
      await configService.saveGroup(group, expectedGroupRevision);
      return configService.getModelGroupsConfig();
    },
    deleteGroup: async (groupId, replacementGroupId) => {
      await ensureReady();
      await configService.deleteGroup(groupId, replacementGroupId);
      return configService.getModelGroupsConfig();
    },
    duplicateGroup: async (sourceGroupId, newId) => {
      await ensureReady();
      await configService.duplicateGroup(
        sourceGroupId,
        newId,
        () => crypto.randomUUID(),
      );
      return configService.getModelGroupsConfig();
    },
    setDefaultTarget: async (target) => {
      await ensureReady();
      await configService.setDefaultTarget(target);
      return configService.getModelGroupsConfig();
    },
    setWorkloadDefault: async (level, groupId) => {
      await ensureReady();
      await configService.setWorkloadDefault(level, groupId);
      return configService.getModelGroupsConfig();
    },
  };
}
