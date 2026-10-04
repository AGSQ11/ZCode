import { useEffect, useState } from "react";
import type { IModelGroupsService } from "@zcode/services";
import type { ModelGroup, ModelGroupsConfig } from "@zcode/shared/model-group-types";
import { logger } from "@/logger.js";

/**
 * 订阅目标 Host 的 enabled 模型组目录（Composer 菜单与 Subagent 设置共用）。
 * 权威事实来自 modelGroupsService，调用方不自行缓存或推断。
 */
export function useEnabledModelGroups(service: IModelGroupsService | undefined): ModelGroup[] {
  const [enabledGroups, setEnabledGroups] = useState<ModelGroup[]>([]);
  useEffect(() => {
    // 服务实例切换或读取失败时必须清空旧状态：保留上一服务的组会把失效
    // 目标留在菜单里，选中后路由到已不存在的组（悬空状态）。
    setEnabledGroups([]);
    if (!service) {
      return undefined;
    }
    let disposed = false;
    const apply = (config: ModelGroupsConfig) => {
      if (!disposed) setEnabledGroups(config.groups.filter((group) => group.enabled));
    };
    void service
      .getConfig()
      .then(apply)
      .catch((error) => {
        logger.warn("[model-groups] 目录加载失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!disposed) setEnabledGroups([]);
      });
    const subscription = service.onDidChange(apply);
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [service]);
  return enabledGroups;
}
