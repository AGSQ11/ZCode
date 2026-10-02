/* oxlint-disable eslint(max-lines) */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useServices } from "@/hooks/useServices.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
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
import { Plus, Trash2, Copy, Save, X, Edit2 } from "lucide-react";
import { toast } from "@/components/ui/toast.js";

export function ModelGroupsSection() {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const providerSettingsRead = useProviderSettingsView();
  const modelGroupsService = services.modelGroupsService;

  const [config, setConfig] = useState<ModelGroupsConfig>(DEFAULT_MODEL_GROUPS_CONFIG);
  const [loading, setLoading] = useState(true);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupDraft, setEditingGroupDraft] = useState<ModelGroup | null>(null);

  const reloadConfig = useCallback(async () => {
    if (!modelGroupsService) return;
    try {
      setLoading(true);
      const latest = await modelGroupsService.getConfig();
      setConfig(latest);
    } catch (error) {
      toast(`Failed to load model groups: ${String(error)}`);
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

  const handleCreateGroup = () => {
    const newGroup: ModelGroup = {
      id: crypto.randomUUID(),
      revision: 1,
      name: `Group ${config.groups.length + 1}`,
      members: [],
      ...DEFAULT_MODEL_GROUP,
    };
    setEditingGroupId(newGroup.id);
    setEditingGroupDraft(newGroup);
  };

  const handleDuplicateGroup = async (groupId: string) => {
    if (!modelGroupsService) return;
    try {
      await modelGroupsService.duplicateGroup(groupId, crypto.randomUUID());
      toast("Group duplicated successfully");
      await reloadConfig();
    } catch (error) {
      toast(`Duplicate failed: ${String(error)}`);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!modelGroupsService) return;
    try {
      await modelGroupsService.deleteGroup(groupId);
      toast("Group deleted successfully");
      if (editingGroupId === groupId) {
        setEditingGroupId(null);
        setEditingGroupDraft(null);
      }
      await reloadConfig();
    } catch (error) {
      toast(`Delete failed: ${String(error)}`);
    }
  };

  const handleSaveDraft = async () => {
    if (!modelGroupsService || !editingGroupDraft) return;
    if (!validateGroupName(editingGroupDraft.name)) {
      toast("Group name must be 1..80 NFC characters with no control characters");
      return;
    }
    if (editingGroupDraft.enabled && !editingGroupDraft.members.some((m) => m.enabled)) {
      toast("An enabled group must have at least one enabled member");
      return;
    }
    try {
      await modelGroupsService.saveGroup(editingGroupDraft);
      toast("Group saved successfully");
      setEditingGroupId(null);
      setEditingGroupDraft(null);
      await reloadConfig();
    } catch (error) {
      toast(`Save failed: ${String(error)}`);
    }
  };

  const availableModels = useMemo(() => {
    const view = providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
    if (!view) return [];
    return view.providers.flatMap((p: any) =>
      p.models.map((m: any) => ({
        providerId: p.providerId,
        providerName: p.providerName || p.providerId,
        modelId: m.modelId,
        displayName: m.displayName || m.modelId,
        reasoningLevel: m.config?.properties?.reasoningLevel || "low",
      })),
    );
  }, [providerSettingsRead.state]);

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

      {editingGroupDraft ? (
        <SettingsGroupCard>
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h4 className="font-medium text-foreground">
                {intl.formatMessage({ id: "settings.modelGroups.editorTitle" })}
              </h4>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditingGroupDraft(null)}>
                  <X className="h-4 w-4 mr-1" />
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSaveDraft}>
                  <Save className="h-4 w-4 mr-1" />
                  Save Group
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
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                >
                  {WORKLOAD_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {lvl.toUpperCase()}
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
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                >
                  {ROUTING_STRATEGIES.map((strat) => (
                    <option key={strat} value={strat}>
                      {strat.replace("_", " ").toUpperCase()}
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
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                >
                  <option value="turn">Turn-sticky (Recommended)</option>
                  <option value="request">Per-request balanced</option>
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
                  disabled={editingGroupDraft.members.length >= 32}
                  onClick={() => {
                    if (availableModels.length === 0) return;
                    const first = availableModels[0]!;
                    const newMember: ModelGroupMember = {
                      id: crypto.randomUUID(),
                      selection: {
                        providerId: first.providerId,
                        modelId: first.modelId,
                        options: { reasoningLevel: first.reasoningLevel },
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
                  Add Member
                </Button>
              </div>

              <div className="space-y-2">
                {editingGroupDraft.members.map((m, idx) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-surface p-2.5 text-sm"
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={m.enabled}
                        onChange={(e) => {
                          const nextMembers = [...editingGroupDraft.members];
                          nextMembers[idx] = { ...m, enabled: e.target.checked };
                          setEditingGroupDraft({ ...editingGroupDraft, members: nextMembers });
                        }}
                      />
                      <select
                        value={`${m.selection.providerId}\u0000${m.selection.modelId}`}
                        onChange={(e) => {
                          const [pId, mId] = e.target.value.split("\u0000");
                          const nextMembers = [...editingGroupDraft.members];
                          nextMembers[idx] = {
                            ...m,
                            selection: {
                              providerId: pId!,
                              modelId: mId!,
                              options: m.selection.options,
                            },
                          };
                          setEditingGroupDraft({ ...editingGroupDraft, members: nextMembers });
                        }}
                        className="rounded border border-input bg-background px-2 py-1"
                      >
                        {availableModels.map((opt: any) => (
                          <option
                            key={`${opt.providerId}/${opt.modelId}`}
                            value={`${opt.providerId}\u0000${opt.modelId}`}
                          >
                            {opt.providerName} / {opt.displayName}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-3">
                      {editingGroupDraft.strategy === "balanced" && (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-foreground-subtle">Weight:</span>
                          <Input
                            type="number"
                            min="1"
                            max="100"
                            value={m.weight}
                            onChange={(e) => {
                              const nextMembers = [...editingGroupDraft.members];
                              nextMembers[idx] = { ...m, weight: Math.max(1, parseInt(e.target.value) || 1) };
                              setEditingGroupDraft({ ...editingGroupDraft, members: nextMembers });
                            }}
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
                ))}
              </div>
            </div>
          </div>
        </SettingsGroupCard>
      ) : null}

      <div className="space-y-3">
        {config.groups.map((group) => (
          <SettingsGroupCard key={group.id}>
            <div className="flex items-center justify-between p-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground">{group.name}</span>
                  <SettingsBadge>{group.workloadLevel.toUpperCase()}</SettingsBadge>
                  <span className="text-xs text-foreground-subtle">
                    {group.strategy.replace("_", " ")} • {group.members.filter((m) => m.enabled).length}/{group.members.length} members
                  </span>
                  {!group.enabled && (
                    <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                      Disabled
                    </span>
                  )}
                </div>
                {group.description ? (
                  <p className="text-sm text-foreground-subtle">{group.description}</p>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditingGroupId(group.id);
                    setEditingGroupDraft({ ...group });
                  }}
                >
                  <Edit2 className="h-3.5 w-3.5 mr-1" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleDuplicateGroup(group.id)}
                >
                  <Copy className="h-3.5 w-3.5 mr-1" />
                  Duplicate
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
        ))}

        {config.groups.length === 0 && !loading && (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelGroups.empty" })}
          </div>
        )}
      </div>
    </div>
  );
}
