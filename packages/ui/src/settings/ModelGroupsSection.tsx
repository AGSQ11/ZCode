/* oxlint-disable eslint(max-lines) */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useServices } from "@/hooks/useServices.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import {
  SettingsGroupCard,
  SettingsRow,
  SettingsBadge,
} from "./SettingsPageParts.js";
import {
  type ModelGroup,
  type ModelGroupsConfig,
  type ModelGroupMember,
  type RoutingStrategy,
  type WorkloadLevel,
  DEFAULT_MODEL_GROUP,
  DEFAULT_MODEL_GROUPS_CONFIG,
  ROUTING_STRATEGIES,
  WORKLOAD_LEVELS,
  validateGroupName,
} from "@zcode/shared/model-group-types";
import { Plus, Trash2, Copy, Save, X, Edit2, AlertTriangle } from "lucide-react";
import { toast } from "@/components/ui/toast.js";

/** 配置面模型目录条目：来自 ProviderSettingsView 的真实形状（effectiveConfig.optionSpecs）。 */
interface AvailableModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  /** 该模型 optionSpecs 声明的全部 reasoning 档位（按语义强度从低到高）。 */
  reasoningValues: readonly string[];
}

function memberOptionKey(providerId: string, modelId: string): string {
  // 分隔符必须与 shared modelGroupSchema 的重复成员检测键一致。
  return `${providerId}\u0000${modelId}`;
}

/** CAS 冲突错误消息：`Model Group revision conflict: expected X, found Y`（见 provider config-service）。 */
function parseGroupRevisionConflict(error: unknown): { expected: string; found: string } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /Model Group revision conflict: expected (\d+), found (\d+)/.exec(message);
  if (!match) return null;
  return { expected: match[1]!, found: match[2]! };
}

export function ModelGroupsSection() {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const confirmDialog = useConfirmDialog();
  const providerSettingsRead = useProviderSettingsView();
  const modelGroupsService = services.modelGroupsService;

  const [config, setConfig] = useState<ModelGroupsConfig>(DEFAULT_MODEL_GROUPS_CONFIG);
  const [loading, setLoading] = useState(true);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupDraft, setEditingGroupDraft] = useState<ModelGroup | null>(null);
  // 编辑器打开时冻结的组 revision；保存时作为 CAS 期望值，防止 stale editor 覆盖他处写入。
  const [editingBaseRevision, setEditingBaseRevision] = useState<number | null>(null);

  const reloadConfig = useCallback(async () => {
    if (!modelGroupsService) return;
    try {
      setLoading(true);
      const latest = await modelGroupsService.getConfig();
      setConfig(latest);
    } catch (error) {
      toast(intl.formatMessage({ id: "settings.modelGroups.errorLoad" }, { error: String(error) }));
    } finally {
      setLoading(false);
    }
  }, [modelGroupsService]);

  useEffect(() => {
    void reloadConfig();
    if (!modelGroupsService) return;
    const unsub = modelGroupsService.onDidChange((latest) => {
      setConfig(latest);
    });
    return () => unsub.dispose();
  }, [modelGroupsService, reloadConfig]);

  // Bug 修复（P2-2）：ProviderSettingsView 的模型条目是 ProviderSettingsModelView，
  // 其 reasoning 档位在 effectiveConfig.optionSpecs.reasoningLevel.values；
  // 旧代码读取不存在的 m.config?.properties?.reasoningLevel 与 m.displayName，
  // 导致每个成员的 reasoning 恒为 "low"、显示名恒为 modelId。
  const availableModels = useMemo<AvailableModelOption[]>(() => {
    const view = providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
    if (!view) return [];
    return view.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.providerId,
        providerName: provider.providerName?.trim() || provider.providerId,
        modelId: model.modelId,
        reasoningValues: model.effectiveConfig.optionSpecs?.reasoningLevel?.values ?? [],
      })),
    );
  }, [providerSettingsRead.state]);

  const availableModelKeys = useMemo(
    () => new Set(availableModels.map((option) => memberOptionKey(option.providerId, option.modelId))),
    [availableModels],
  );

  /** 成员计数：configured = 全部引用；enabled = 启用；available = 引用在当前配置面目录中存在。 */
  const countAvailableMembers = useCallback(
    (group: ModelGroup): { configured: number; enabled: number; available: number } => ({
      configured: group.members.length,
      enabled: group.members.filter((member) => member.enabled).length,
      available: group.members.filter((member) =>
        availableModelKeys.has(memberOptionKey(member.selection.providerId, member.selection.modelId)),
      ).length,
    }),
    [availableModelKeys],
  );

  const openEditor = useCallback((group: ModelGroup) => {
    setEditingGroupId(group.id);
    setEditingGroupDraft({ ...group });
    // 冻结加载时的 revision；保存路径用它触发 config-service 的组级 CAS。
    setEditingBaseRevision(group.revision);
  }, []);

  const handleCreateGroup = () => {
    // 默认值先展开、身份字段后赋值：若 DEFAULT_MODEL_GROUP 未来新增 id/name/revision/members
    // 叶子，反向顺序会让默认值静默覆盖新建组身份（复制出重复 id）。
    const newGroup: ModelGroup = {
      ...DEFAULT_MODEL_GROUP,
      id: crypto.randomUUID(),
      revision: 1,
      name: `Group ${config.groups.length + 1}`,
      members: [],
    };
    setEditingGroupId(newGroup.id);
    setEditingGroupDraft(newGroup);
    // 新建组在服务端尚不存在；不传期望 revision 走创建分支。
    setEditingBaseRevision(null);
  };

  const handleDuplicateGroup = async (groupId: string) => {
    if (!modelGroupsService) return;
    try {
      await modelGroupsService.duplicateGroup(groupId, crypto.randomUUID());
      toast(intl.formatMessage({ id: "settings.modelGroups.duplicateSuccess" }));
      await reloadConfig();
    } catch (error) {
      toast(intl.formatMessage({ id: "settings.modelGroups.errorDuplicate" }, { error: String(error) }));
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!modelGroupsService) return;
    // 删除是不可逆的破坏性操作且与 Edit/Duplicate 相邻--先经确认对话框，
    // 与 CAS 冲突流共用一个确认组件，避免单击误删整组配置（F）。
    const group = config.groups.find((g) => g.id === groupId);
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "settings.modelGroups.deleteTitle" }),
      description: intl.formatMessage(
        { id: "settings.modelGroups.deleteDesc" },
        { name: group?.name ?? groupId },
      ),
      confirmLabel: intl.formatMessage({ id: "settings.modelGroups.deleteConfirm" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    try {
      await modelGroupsService.deleteGroup(groupId);
      toast(intl.formatMessage({ id: "settings.modelGroups.deleteSuccess" }));
      if (editingGroupId === groupId) {
        setEditingGroupId(null);
        setEditingGroupDraft(null);
        setEditingBaseRevision(null);
      }
      await reloadConfig();
    } catch (error) {
      toast(intl.formatMessage({ id: "settings.modelGroups.errorDelete" }, { error: String(error) }));
    }
  };

  /** 冲突后的权威重载：丢弃本地草稿，重新读取服务端配置。 */
  const handleReloadAfterConflict = useCallback(async () => {
    await reloadConfig();
    const latest = await modelGroupsService?.getConfig().catch(() => null);
    const fresh = latest?.groups.find((group) => group.id === editingGroupId);
    if (fresh) {
      openEditor(fresh);
    } else {
      // 组已在他处被删除：退出编辑器，不再持有失效草稿。
      setEditingGroupId(null);
      setEditingGroupDraft(null);
      setEditingBaseRevision(null);
    }
  }, [editingGroupId, modelGroupsService, openEditor, reloadConfig]);

  const handleSaveDraft = async () => {
    if (!modelGroupsService || !editingGroupDraft) return;
    if (!validateGroupName(editingGroupDraft.name)) {
      toast(intl.formatMessage({ id: "settings.modelGroups.errorNameInvalid" }));
      return;
    }
    if (editingGroupDraft.enabled && !editingGroupDraft.members.some((m) => m.enabled)) {
      toast(intl.formatMessage({ id: "settings.modelGroups.errorNoEnabledMember" }));
      return;
    }
    try {
      // 新建（baseRevision=null）不传期望值走创建分支；编辑既有组必须携带加载时的
      // revision 触发 CAS，否则 stale editor 会静默覆盖他处写入（P1-4）。
      await modelGroupsService.saveGroup(
        editingGroupDraft,
        editingBaseRevision ?? undefined,
      );
      toast(intl.formatMessage({ id: "settings.modelGroups.saveSuccess" }));
      setEditingGroupId(null);
      setEditingGroupDraft(null);
      setEditingBaseRevision(null);
      await reloadConfig();
    } catch (error) {
      const conflict = parseGroupRevisionConflict(error);
      if (conflict) {
        // CAS 冲突：不是 last-write-wins；提示并显式 Reload 权威配置。
        const confirmed = await confirmDialog({
          title: intl.formatMessage({ id: "settings.modelGroups.conflictTitle" }),
          description: intl.formatMessage(
            { id: "settings.modelGroups.conflictDesc" },
            { expected: conflict.expected, found: conflict.found },
          ),
          confirmLabel: intl.formatMessage({ id: "settings.modelGroups.conflictReload" }),
        });
        if (confirmed) {
          await handleReloadAfterConflict();
        }
        return;
      }
      toast(intl.formatMessage({ id: "settings.modelGroups.errorSave" }, { error: String(error) }));
    }
  };

  const handleSetWorkloadDefault = async (level: WorkloadLevel, groupId: string) => {
    if (!modelGroupsService) return;
    try {
      await modelGroupsService.setWorkloadDefault(level, groupId || undefined);
      await reloadConfig();
    } catch (error) {
      toast(intl.formatMessage({ id: "settings.modelGroups.errorWorkloadDefault" }, { error: String(error) }));
    }
  };

  const updateMember = useCallback(
    (index: number, next: ModelGroupMember) => {
      if (!editingGroupDraft) return;
      const nextMembers = [...editingGroupDraft.members];
      nextMembers[index] = next;
      setEditingGroupDraft({ ...editingGroupDraft, members: nextMembers });
    },
    [editingGroupDraft],
  );

  const handleSelectMemberModel = useCallback(
    (index: number, encoded: string) => {
      if (!editingGroupDraft) return;
      const member = editingGroupDraft.members[index];
      if (!member) return;
      // Bug 修复（P2-2）：换模型时必须用目标模型 optionSpecs 里的有效档位；
      // 沿用源模型的 reasoning 会保存一个目标模型不支持的档位。
      const option = availableModels.find(
        (candidate) => memberOptionKey(candidate.providerId, candidate.modelId) === encoded,
      );
      if (!option) return;
      // Bug 修复（L）：选择模型时阻止与其它成员撞 (providerId, modelId) 重复--
      // schema 保存时才拒绝会让用户面对不透明错误。
      const duplicate = editingGroupDraft.members.some(
        (m, i) =>
          i !== index &&
          m.selection.providerId === option.providerId &&
          m.selection.modelId === option.modelId,
      );
      if (duplicate) {
        toast(intl.formatMessage({ id: "settings.modelGroups.duplicateMemberModel" }));
        return;
      }
      const previousLevel = member.selection.options?.reasoningLevel;
      const reasoningLevel =
        previousLevel && option.reasoningValues.includes(previousLevel)
          ? previousLevel
          : option.reasoningValues[0];
      updateMember(index, {
        ...member,
        selection: {
          providerId: option?.providerId ?? member.selection.providerId,
          modelId: option?.modelId ?? member.selection.modelId,
          ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
        },
      });
    },
    [availableModels, editingGroupDraft, updateMember],
  );

  const handleSelectMemberReasoning = useCallback(
    (index: number, reasoningLevel: string) => {
      if (!editingGroupDraft) return;
      const member = editingGroupDraft.members[index];
      if (!member) return;
      updateMember(index, {
        ...member,
        selection: {
          ...member.selection,
          options: { reasoningLevel },
        },
      });
    },
    [editingGroupDraft, updateMember],
  );

  const selectClassName = "rounded-md border border-input bg-background px-3 py-1.5 text-sm";
  const workloadLevelLabel = useCallback(
    (level: WorkloadLevel): string =>
      intl.formatMessage({ id: `settings.modelGroups.workloadLevel.${level}` }),
    [intl],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.modelGroups.title" })}
          </h3>
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelGroups.description" })}
          </p>
        </div>
        <Button onClick={handleCreateGroup} size="sm" className="gap-1.5">
          <Plus className="h-4 w-4" />
          {intl.formatMessage({ id: "settings.modelGroups.createGroup" })}
        </Button>
      </div>

      <SettingsGroupCard>
        <div className="space-y-3 p-4">
          <div>
            <h4 className="font-medium text-foreground">
              {intl.formatMessage({ id: "settings.modelGroups.workloadDefaultsTitle" })}
            </h4>
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelGroups.workloadDefaultsDesc" })}
            </p>
          </div>
          {WORKLOAD_LEVELS.map((level) => {
            const candidates = config.groups.filter((group) => group.workloadLevel === level);
            return (
              <SettingsRow
                key={level}
                label={workloadLevelLabel(level)}
                control={
                  <select
                    value={config.workloadDefaults[level] ?? ""}
                    onChange={(event) => void handleSetWorkloadDefault(level, event.target.value)}
                    className={selectClassName}
                  >
                    <option value="">
                      {intl.formatMessage({ id: "settings.modelGroups.workloadDefault.none" })}
                    </option>
                    {candidates.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                }
              />
            );
          })}
        </div>
      </SettingsGroupCard>

      {editingGroupDraft ? (
        <SettingsGroupCard>
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h4 className="font-medium text-foreground">
                {intl.formatMessage({ id: "settings.modelGroups.editorTitle" })}
              </h4>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingGroupId(null);
                    setEditingGroupDraft(null);
                    setEditingBaseRevision(null);
                  }}
                >
                  <X className="h-4 w-4 mr-1" />
                  {intl.formatMessage({ id: "settings.modelGroups.cancel" })}
                </Button>
                <Button size="sm" onClick={handleSaveDraft}>
                  <Save className="h-4 w-4 mr-1" />
                  {intl.formatMessage({ id: "settings.modelGroups.saveGroup" })}
                </Button>
              </div>
            </div>

            <SettingsRow
              label={intl.formatMessage({ id: "settings.modelGroups.fieldName" })}
              description={intl.formatMessage({ id: "settings.modelGroups.fieldNameDesc" })}
              control={
                <Input
                  value={editingGroupDraft.name}
                  onChange={(e) =>
                    setEditingGroupDraft({ ...editingGroupDraft, name: e.target.value })
                  }
                  className="w-64"
                />
              }
            />

            <SettingsRow
              label={intl.formatMessage({ id: "settings.modelGroups.fieldWorkload" })}
              description={intl.formatMessage({ id: "settings.modelGroups.fieldWorkloadDesc" })}
              control={
                <select
                  value={editingGroupDraft.workloadLevel}
                  onChange={(e) =>
                    setEditingGroupDraft({
                      ...editingGroupDraft,
                      workloadLevel: e.target.value as WorkloadLevel,
                    })
                  }
                  className={selectClassName}
                >
                  {WORKLOAD_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {workloadLevelLabel(lvl)}
                    </option>
                  ))}
                </select>
              }
            />

            <SettingsRow
              label={intl.formatMessage({ id: "settings.modelGroups.fieldStrategy" })}
              description={intl.formatMessage({ id: "settings.modelGroups.fieldStrategyDesc" })}
              control={
                <select
                  value={editingGroupDraft.strategy}
                  onChange={(e) =>
                    setEditingGroupDraft({
                      ...editingGroupDraft,
                      strategy: e.target.value as RoutingStrategy,
                    })
                  }
                  className={selectClassName}
                >
                  {ROUTING_STRATEGIES.map((strat) => (
                    <option key={strat} value={strat}>
                      {intl.formatMessage({ id: `settings.modelGroups.strategy.${strat}` })}
                    </option>
                  ))}
                </select>
              }
            />

            <SettingsRow
              label={intl.formatMessage({ id: "settings.modelGroups.fieldAffinity" })}
              description={intl.formatMessage({ id: "settings.modelGroups.fieldAffinityDesc" })}
              control={
                <select
                  value={editingGroupDraft.affinity}
                  onChange={(e) =>
                    setEditingGroupDraft({
                      ...editingGroupDraft,
                      affinity: e.target.value as "turn" | "request",
                    })
                  }
                  className={selectClassName}
                >
                  <option value="turn">{intl.formatMessage({ id: "settings.modelGroups.affinityTurn" })}</option>
                  <option value="request">{intl.formatMessage({ id: "settings.modelGroups.affinityRequest" })}</option>
                </select>
              }
            />

            <div className="pt-2">
              <div className="flex items-center justify-between pb-2">
                <h5 className="font-medium text-foreground text-sm">
                  {intl.formatMessage({ id: "settings.modelGroups.membersTitle" })} ({editingGroupDraft.members.length}/32)
                </h5>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={editingGroupDraft.members.length >= 32 || availableModels.length === 0}
                  onClick={() => {
                    if (availableModels.length === 0) return;
                    // Bug 修复（L）：追加首个与现有成员不重复 (providerId, modelId) 的模型，
                    // 避免保存时撞 schema 的重复成员校验并只得到不透明错误。
                    // 键必须与 memberOptionKey（=schema 重复检测键）一致--'|' 分隔符在
                    // id 含 '|' 时会假碰撞（如 a|b/c vs a/b|c）。
                    const existingKeys = new Set(
                      editingGroupDraft.members.map((m) =>
                        memberOptionKey(m.selection.providerId, m.selection.modelId),
                      ),
                    );
                    const first =
                      availableModels.find(
                        (m) => !existingKeys.has(memberOptionKey(m.providerId, m.modelId)),
                      ) ?? null;
                    if (!first) {
                      toast(intl.formatMessage({ id: "settings.modelGroups.noNewMemberModel" }));
                      return;
                    }
                    // Bug 修复（P2-2）：新成员使用目标模型的首个配置档位，
                    // 不再硬编码 "low"（该档位未必存在于 optionSpecs）。
                    const reasoningLevel = first.reasoningValues[0];
                    const newMember: ModelGroupMember = {
                      id: crypto.randomUUID(),
                      selection: {
                        providerId: first.providerId,
                        modelId: first.modelId,
                        ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
                      },
                      enabled: true,
                      weight: 1,
                      maxInFlight: null,
                    };
                    setEditingGroupDraft({
                      ...editingGroupDraft,
                      members: [...editingGroupDraft.members, newMember],
                    });
                  }}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  {intl.formatMessage({ id: "settings.modelGroups.addMember" })}
                </Button>
              </div>

              <div className="space-y-2">
                {editingGroupDraft.members.map((member, idx) => {
                  const memberKey = memberOptionKey(
                    member.selection.providerId,
                    member.selection.modelId,
                  );
                  const broken = !availableModelKeys.has(memberKey);
                  const boundOption = broken
                    ? undefined
                    : availableModels.find(
                        (candidate) => memberOptionKey(candidate.providerId, candidate.modelId) === memberKey,
                      );
                  return (
                    <div
                      key={member.id}
                      className="flex items-center justify-between rounded-lg border border-border bg-surface p-2.5 text-sm"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <input
                          type="checkbox"
                          checked={member.enabled}
                          onChange={(e) =>
                            updateMember(idx, { ...member, enabled: e.target.checked })
                          }
                        />
                        <select
                          value={broken ? "" : memberKey}
                          onChange={(e) => {
                            if (!e.target.value) return;
                            handleSelectMemberModel(idx, e.target.value);
                          }}
                          className="rounded border border-input bg-background px-2 py-1"
                        >
                          {broken ? (
                            // 失效引用保持可见：显示原引用并占位，不把成员静默改绑到别的模型。
                            <option value="" disabled>
                              ⚠ {member.selection.providerId}/{member.selection.modelId}
                            </option>
                          ) : null}
                          {availableModels.map((opt) => (
                            <option
                              key={memberOptionKey(opt.providerId, opt.modelId)}
                              value={memberOptionKey(opt.providerId, opt.modelId)}
                            >
                              {opt.providerName} / {opt.modelId}
                            </option>
                          ))}
                        </select>
                        {broken ? (
                          <span
                            className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning"
                            title={intl.formatMessage({
                              id: "settings.modelGroups.brokenReferenceDesc",
                            })}
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {intl.formatMessage({ id: "settings.modelGroups.brokenReference" })}
                          </span>
                        ) : null}
                        {!broken && (boundOption?.reasoningValues.length ?? 0) > 0 ? (
                          <label className="flex items-center gap-1 text-xs text-foreground-subtle">
                            {intl.formatMessage({ id: "settings.modelGroups.reasoningLevel" })}:
                            <select
                              value={
                                member.selection.options?.reasoningLevel &&
                                boundOption!.reasoningValues.includes(
                                  member.selection.options.reasoningLevel,
                                )
                                  ? member.selection.options.reasoningLevel
                                  : boundOption!.reasoningValues[0]!
                              }
                              onChange={(e) => handleSelectMemberReasoning(idx, e.target.value)}
                              className="rounded border border-input bg-background px-1.5 py-1 text-xs"
                            >
                              {boundOption!.reasoningValues.map((level) => (
                                <option key={level} value={level}>
                                  {level}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-3">
                        {editingGroupDraft.strategy === "balanced" && (
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-foreground-subtle">{intl.formatMessage({ id: "settings.modelGroups.weight" })}</span>
                            <Input
                              type="number"
                              min="1"
                              max="100"
                              value={member.weight}
                              onChange={(e) =>
                                updateMember(idx, {
                                  ...member,
                                  // 双向钳制到声明的 1..100：HTML max 不约束手输，超上限值会在 schema 保存时
                                  // 才失败成不透明错误。
                                  weight: Math.min(100, Math.max(1, parseInt(e.target.value) || 1)),
                                })
                              }
                              className="w-16 h-7 text-xs"
                            />
                          </div>
                        )}

                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive"
                          onClick={() => {
                            const nextMembers = editingGroupDraft.members.filter((_, i) => i !== idx);
                            setEditingGroupDraft({ ...editingGroupDraft, members: nextMembers });
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </SettingsGroupCard>
      ) : null}

      <div className="space-y-3">
        {config.groups.map((group) => {
          const counts = countAvailableMembers(group);
          return (
            <SettingsGroupCard key={group.id}>
              <div className="flex items-center justify-between p-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">{group.name}</span>
                    <SettingsBadge>{workloadLevelLabel(group.workloadLevel)}</SettingsBadge>
                    <span className="text-xs text-foreground-subtle">
                      {intl.formatMessage({ id: `settings.modelGroups.strategy.${group.strategy}` })} •{" "}
                      {intl.formatMessage(
                        { id: "settings.modelGroups.memberCounts" },
                        {
                          configured: counts.configured,
                          enabled: counts.enabled,
                          available: counts.available,
                        },
                      )}
                    </span>
                    {!group.enabled && (
                      <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                        {intl.formatMessage({ id: "settings.modelGroups.disabledBadge" })}
                      </span>
                    )}
                  </div>
                  {group.description ? (
                    <p className="text-sm text-foreground-subtle">{group.description}</p>
                  ) : null}
                </div>

                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => openEditor(group)}>
                    <Edit2 className="h-3.5 w-3.5 mr-1" />
                    {intl.formatMessage({ id: "settings.modelGroups.edit" })}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleDuplicateGroup(group.id)}
                  >
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    {intl.formatMessage({ id: "settings.modelGroups.duplicate" })}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={() => handleDeleteGroup(group.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </SettingsGroupCard>
          );
        })}

        {config.groups.length === 0 && !loading && (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelGroups.empty" })}
          </div>
        )}
      </div>
    </div>
  );
}
