"use client";

import { Pencil, Plus, SmilePlus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { IconPicker } from "@/components/page/icon-picker";
import { useColorScheme } from "@/components/theme/theme-provider";
import { Button, IconButton, Input, cn, selectClass } from "@/components/ui";
import { BLOCK_COLORS, type BlockColor } from "@/lib/block-colors";
import {
  CALLOUT_BORDERS,
  MAX_CALLOUT_KEY,
  MAX_CALLOUT_NAME,
  MAX_CALLOUT_STYLES,
  MAX_CALLOUT_TITLE,
  parseCalloutStyles,
  type CalloutBorder,
  type CalloutStyle,
  type CalloutStyleProblem,
} from "@/lib/callout-styles";
import { useAction } from "./workspace-settings";

const EMPTY: CalloutStyle = { key: "", name: "", icon: "💡", color: "gray", border: "left", title: "" };

/** A key from a name: lowercase letters and digits, dashes between words (accents dropped). */
function slugOf(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CALLOUT_KEY)
    .replace(/-+$/, "");
}

/**
 * A callout drawn the way the editor draws one of the style, for the list and the form. Inside a
 * `bn-container` so it takes the editor's block colors (globals.css), in the current scheme.
 */
export function CalloutPreview({ style, text }: { style: CalloutStyle; text: string }) {
  const scheme = useColorScheme();
  return (
    <div className="bn-container min-w-0 flex-1" data-color-scheme={scheme}>
      <div className="leafdesk-callout-preview" data-callout-color={style.color} data-callout-border={style.border}>
        {style.icon && <span className="leafdesk-callout-icon">{style.icon}</span>}
        <div className="min-w-0 flex-1">
          {style.title && <div className="leafdesk-callout-title truncate">{style.title}</div>}
          <div className="truncate text-sm">{text}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Settings > General > Callout styles: the workspace's named box styles (lib/callout-styles).
 * Owners add, change and remove them; everyone else sees the list. The whole list is saved at once.
 */
export function CalloutStylesSettings({ workspaceId, styles, canEdit }: { workspaceId: string; styles: CalloutStyle[]; canEdit: boolean }) {
  const t = useTranslations("settings.calloutStyles");
  const router = useRouter();
  const { pending, error, run } = useAction();
  // The style being edited: its place in the list, or the list's length for a new one.
  const [editing, setEditing] = useState<number | null>(null);

  const save = (next: CalloutStyle[], done?: () => void) =>
    run(
      () => updateWorkspaceSettingsAction(workspaceId, { calloutStyles: next }),
      () => {
        done?.();
        router.refresh();
      },
    );

  return (
    <>
      {styles.length === 0 && editing === null && <p className="px-5 py-4 text-sm text-fg-muted">{t("empty")}</p>}
      {styles.map((style, i) =>
        editing === i ? (
          <StyleForm
            key={style.key}
            initial={style}
            others={styles.filter((_, j) => j !== i)}
            pending={pending}
            serverError={error}
            onCancel={() => setEditing(null)}
            onSave={(next) => save(styles.map((s, j) => (j === i ? next : s)), () => setEditing(null))}
          />
        ) : (
          <div key={style.key} className="flex items-center gap-4 px-5 py-3">
            <CalloutPreview style={style} text={t("previewText")} />
            <div className="w-36 shrink-0 text-sm">
              <div className="truncate font-medium">{style.name}</div>
              <div className="truncate text-fg-muted">{style.key}</div>
            </div>
            {canEdit && (
              <div className="flex shrink-0 gap-1">
                <IconButton label={t("edit")} onClick={() => setEditing(i)} disabled={pending}>
                  <Pencil className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  label={t("remove", { name: style.name })}
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm(t("removeConfirm", { name: style.name }))) save(styles.filter((_, j) => j !== i));
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            )}
          </div>
        ),
      )}
      {editing === styles.length && (
        <StyleForm
          initial={EMPTY}
          others={styles}
          isNew
          pending={pending}
          serverError={error}
          onCancel={() => setEditing(null)}
          onSave={(next) => save([...styles, next], () => setEditing(null))}
        />
      )}
      <div className="flex items-center gap-3 px-5 py-3 text-sm text-fg-muted">
        <span className="flex-1">{canEdit ? t("count", { count: styles.length, max: MAX_CALLOUT_STYLES }) : t("ownersOnly")}</span>
        {error && editing === null && <span className="text-danger">{error}</span>}
        {canEdit && editing === null && (
          <Button size="sm" onClick={() => setEditing(styles.length)} disabled={pending || styles.length >= MAX_CALLOUT_STYLES}>
            <Plus className="h-3.5 w-3.5" />
            {t("add")}
          </Button>
        )}
      </div>
    </>
  );
}

function StyleForm({
  initial,
  others,
  isNew = false,
  pending,
  serverError,
  onCancel,
  onSave,
}: {
  initial: CalloutStyle;
  others: CalloutStyle[];
  isNew?: boolean;
  pending: boolean;
  serverError: string | null;
  onCancel: () => void;
  onSave: (style: CalloutStyle) => void;
}) {
  const t = useTranslations("settings.calloutStyles");
  const tc = useTranslations("common");
  const tColors = useTranslations("database.colors");
  const id = useId();
  const scheme = useColorScheme();
  const [style, setStyle] = useState(initial);
  // A new style's key follows its name until someone types a key of their own.
  const [keyTouched, setKeyTouched] = useState(!isNew);
  const [problem, setProblem] = useState<CalloutStyleProblem | null>(null);
  const set = (patch: Partial<CalloutStyle>) => {
    setProblem(null);
    setStyle((current) => ({ ...current, ...patch }));
  };

  return (
    <form
      className="space-y-4 bg-bg px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        const candidate = { ...style, name: style.name.trim(), title: style.title.trim() };
        // Checked against the others as the server will, so the message names the field.
        const parsed = parseCalloutStyles([...others, candidate]);
        if (!parsed.ok) {
          setProblem(parsed.problem);
          return;
        }
        onSave(parsed.styles[parsed.styles.length - 1]);
      }}
    >
      <CalloutPreview style={style} text={t("previewText")} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("name")} htmlFor={`${id}-name`} error={problem === "name" ? t("problems.name") : null}>
          <Input
            id={`${id}-name`}
            value={style.name}
            maxLength={MAX_CALLOUT_NAME}
            autoFocus
            onChange={(e) => set(keyTouched ? { name: e.target.value } : { name: e.target.value, key: slugOf(e.target.value) })}
          />
        </Field>
        <Field
          label={t("key")}
          htmlFor={`${id}-key`}
          help={t("keyHelp", { key: style.key || "key" })}
          error={problem === "key" || problem === "reservedKey" || problem === "duplicateKey" ? t(`problems.${problem}`) : null}
        >
          <Input
            id={`${id}-key`}
            value={style.key}
            maxLength={MAX_CALLOUT_KEY}
            onChange={(e) => {
              setKeyTouched(true);
              set({ key: e.target.value.toLowerCase() });
            }}
          />
        </Field>
        <Field label={t("icon")} error={problem === "icon" ? t("problems.icon") : null}>
          <div className="flex items-center gap-2">
            <IconPicker icon={style.icon || null} onChange={(icon) => set({ icon: icon ?? "" })}>
              {(toggle) => (
                <Button onClick={toggle} aria-label={t("icon")}>
                  {style.icon ? <span className="text-base leading-none">{style.icon}</span> : <SmilePlus className="h-4 w-4 text-fg-faint" />}
                  {t("chooseIcon")}
                </Button>
              )}
            </IconPicker>
            {style.icon && (
              <IconButton label={t("noIcon")} onClick={() => set({ icon: "" })}>
                <X className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>
        </Field>
        <Field label={t("border")} htmlFor={`${id}-border`}>
          <select
            id={`${id}-border`}
            className={cn(selectClass, "w-full")}
            value={style.border}
            onChange={(e) => set({ border: e.target.value as CalloutBorder })}
          >
            {CALLOUT_BORDERS.map((border) => (
              <option key={border} value={border}>
                {t(`borders.${border}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("color")} className="sm:col-span-2">
          <div className="bn-container flex flex-wrap gap-1.5" data-color-scheme={scheme} role="radiogroup" aria-label={t("color")}>
            {BLOCK_COLORS.map((color: BlockColor) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={style.color === color}
                aria-label={color === "default" ? t("noColor") : tColors(color)}
                title={color === "default" ? t("noColor") : tColors(color)}
                onClick={() => set({ color })}
                className={cn(
                  "leafdesk-callout-swatch h-7 w-7 rounded-md border",
                  style.color === color ? "border-accent ring-2 ring-accent/40" : "border-border",
                )}
                data-callout-color={color}
              />
            ))}
          </div>
        </Field>
        <Field
          label={t("title")}
          htmlFor={`${id}-title`}
          help={t("titleHelp")}
          className="sm:col-span-2"
          error={problem === "title" ? t("problems.title") : null}
        >
          <Input
            id={`${id}-title`}
            value={style.title}
            maxLength={MAX_CALLOUT_TITLE}
            placeholder={t("titlePlaceholder")}
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>
      </div>
      <div className="flex items-center justify-end gap-2">
        {(problem === "tooMany" || problem === "color" || problem === "border") && <span className="flex-1 text-sm text-danger">{t(`problems.${problem}`)}</span>}
        {!problem && serverError && <span className="flex-1 text-sm text-danger">{serverError}</span>}
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          {tc("cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? tc("saving") : tc("save")}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  help,
  error,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  help?: string;
  error?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </Label>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : help && <p className="text-xs text-fg-muted">{help}</p>}
    </div>
  );
}
