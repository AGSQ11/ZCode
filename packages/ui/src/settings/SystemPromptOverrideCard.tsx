import { useCallback, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 全局自定义系统提示词编辑卡片。设置后替换默认 Agent 身份/行为 prompt 体系，
 * 保留 CLI 前缀、技能和日期段。空字符串清除覆盖。
 */
export function SystemPromptOverrideCard({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const commit = useCallback(() => {
    if (draft === null) return;
    const trimmed = draft.trim();
    void onChange(trimmed || undefined);
    setDraft(null);
  }, [draft, onChange]);

  const displayed = draft ?? value ?? "";

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.general.systemPrompt.label" })}
        description={intl.formatMessage({
          id: "settings.general.systemPrompt.description",
        })}
        controlLayout="wide"
        control={
          <textarea
            ref={textareaRef}
            className="h-28 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-ui-base text-foreground placeholder:text-foreground-subtlest focus:outline-none focus:ring-2 focus:ring-input-border-focused/30"
            placeholder={intl.formatMessage({
              id: "settings.general.systemPrompt.placeholder",
            })}
            value={displayed}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => setDraft(displayed)}
            onBlur={commit}
            onKeyDown={(event) => {
              // Ctrl/Cmd+Enter 提交
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                textareaRef.current?.blur();
              }
            }}
          />
        }
      />
    </SettingsGroupCard>
  );
}
