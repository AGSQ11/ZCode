import type { ModelSelection, PersonalProviderConfigRepository } from "@zcode/provider";
import type { ExecutionTarget, ModelGroupsConfig } from "@zcode/shared/model-group-types";

export interface NodeModelSelectionConfigRepositoryOptions {
  readonly personalRepository: PersonalProviderConfigRepository;
}

/** 默认选择只是 Personal 文件的一个字段；IO、锁和失效通知由同一个 Repository 拥有。 */
export class NodeModelSelectionConfigRepository {
  readonly #personal: PersonalProviderConfigRepository;
  readonly #subscriptions = new Set<() => void>();
  #disposed = false;

  constructor(options: NodeModelSelectionConfigRepositoryOptions) {
    this.#personal = options.personalRepository;
  }

  async read(): Promise<ModelSelection | undefined> {
    this.#assertNotDisposed();
    const snapshot = await this.#personal.read();
    if (snapshot.defaultModelSelection) return snapshot.defaultModelSelection;
    if (snapshot.defaultTarget?.kind === "model") return snapshot.defaultTarget.selection;
    return undefined;
  }

  async readDefaultTarget(): Promise<ExecutionTarget | undefined> {
    this.#assertNotDisposed();
    const snapshot = await this.#personal.read();
    if (snapshot.defaultTarget) return snapshot.defaultTarget;
    if (snapshot.defaultModelSelection) {
      return { kind: "model", selection: snapshot.defaultModelSelection };
    }
    return undefined;
  }

  async readModelGroupsConfig(): Promise<ModelGroupsConfig | undefined> {
    this.#assertNotDisposed();
    return (await this.#personal.read()).modelGroups;
  }

  async saveConfiguredDefault(
    selection: ModelSelection | undefined,
  ): Promise<ModelSelection | undefined> {
    this.#assertNotDisposed();
    const snapshot = await this.#personal.update((current) => ({
      ...current,
      defaultModelSelection: selection,
      defaultTarget: selection ? { kind: "model", selection } : undefined,
    }));
    return snapshot.defaultModelSelection;
  }

  async saveConfiguredDefaultTarget(
    target: ExecutionTarget | undefined,
  ): Promise<ExecutionTarget | undefined> {
    this.#assertNotDisposed();
    const snapshot = await this.#personal.update((current) => ({
      ...current,
      defaultTarget: target,
      defaultModelSelection: target?.kind === "model" ? target.selection : current.defaultModelSelection,
    }));
    return snapshot.defaultTarget;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    const unsubscribe = this.#personal.onDidChange(listener);
    const dispose = () => {
      this.#subscriptions.delete(dispose);
      unsubscribe();
    };
    this.#subscriptions.add(dispose);
    return dispose;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#subscriptions) dispose();
    // 不销毁共享 Personal Repository；它仍由 Config Runtime 生命周期管理。
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeModelSelectionConfigRepository 已 dispose");
  }
}
