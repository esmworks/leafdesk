"use client";

import { ImageUp, Pencil, Plus, Star, StarOff, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createLetterheadAction, deleteLetterheadAction, setDefaultLetterheadAction, updateLetterheadAction } from "@/app/actions/letterheads";
import { Button, IconButton, Input, Switch, cn, selectClass, textareaClass } from "@/components/ui";
import { formatBytes } from "@/lib/files";
import {
  imageType,
  LOGO_PLACES,
  MAX_FOOTER_LINES,
  MAX_HEADER_LINES,
  MAX_LETTERHEAD_NAME,
  MAX_LETTERHEADS,
  MAX_LOGO_BYTES,
  parseLetterhead,
  tint,
  type Letterhead,
  type LetterheadFields,
  type LetterheadProblem,
  type LogoPlace,
} from "@/lib/letterheads";

const EMPTY: LetterheadFields = { name: "", header: "", footer: "", logoPlace: "left", accent: "", pageNumbers: true };

/** The URL of a letterhead's logo, as the logo route serves it. */
const logoUrl = (l: Letterhead) => (l.hasLogo ? `/api/letterheads/${l.id}/logo?v=${l.logoVersion ?? ""}` : null);

// Paper is drawn as PDFs print it, light in either scheme (server/pdf-document.ts).
const PAPER = { background: "#ffffff", color: "#1f2023", muted: "#6b6d75", faint: "#9a9ca3", border: "#e4e4e7", subtle: "#f7f7f8" };

/**
 * A small sheet showing where a letterhead puts its logo and lines, drawn the same for the form and,
 * scaled down by `zoom`, for the list.
 */
function LetterheadPreview({ fields, logo, zoom, className }: { fields: LetterheadFields; logo: string | null; zoom?: number; className?: string }) {
  const lines = fields.header ? fields.header.split("\n") : [];
  const foot = fields.footer ? fields.footer.split("\n") : [];
  const place = fields.logoPlace;
  const image = logo ? <img src={logo} alt="" className={cn("max-h-7 max-w-[45%] object-contain", place === "center" && "mx-auto")} /> : null;
  const text = (
    <div className={cn("min-w-0 text-[6px] leading-[1.35]", place === "center" ? "text-center" : image && place === "left" ? "text-end" : "text-start")}>
      {lines.map((line, i) => (
        <div key={i} className="truncate" style={i === 0 ? { fontWeight: 600, fontSize: 7 } : { color: PAPER.muted }}>
          {line || " "}
        </div>
      ))}
    </div>
  );
  return (
    <div
      className={cn("flex aspect-[1/1.414] w-44 shrink-0 flex-col overflow-hidden rounded border border-border px-4 py-3.5 shadow-sm", className)}
      style={{ background: PAPER.background, color: PAPER.color, zoom }}
      aria-hidden
    >
      {(image || lines.length > 0) && (
        <>
          {place === "center" ? (
            <div className="space-y-1">
              {image}
              {text}
            </div>
          ) : (
            <div className={cn("flex items-start justify-between gap-2", place === "right" && "flex-row-reverse")}>
              {image}
              <div className={cn("min-w-0", image ? "flex-1" : "w-full")}>{text}</div>
            </div>
          )}
          <div className="mt-1.5" style={{ borderTop: `${fields.accent ? 1.5 : 1}px solid ${fields.accent || PAPER.border}` }} />
        </>
      )}
      <div className="mt-2.5 h-2 w-1/2 rounded-sm" style={{ background: PAPER.color, opacity: 0.85 }} />
      <div className="mt-2 space-y-1">
        {[92, 84, 88].map((w) => (
          <div key={w} className="h-1 rounded-sm" style={{ width: `${w}%`, background: PAPER.border }} />
        ))}
      </div>
      <div className="mt-2 overflow-hidden rounded-sm border" style={{ borderColor: PAPER.border }}>
        <div className="h-2" style={{ background: fields.accent ? tint(fields.accent, 0.86) : PAPER.subtle }} />
        {[0, 1].map((r) => (
          <div key={r} className="h-2 border-t" style={{ borderColor: PAPER.border }} />
        ))}
      </div>
      <div className="flex-1" />
      {(foot.length > 0 || fields.pageNumbers) && (
        <div className={cn("flex items-end gap-2 pt-1 text-[5px] leading-[1.35]", foot.length > 0 && "border-t")} style={{ borderColor: PAPER.border, color: PAPER.muted }}>
          <div className="min-w-0 flex-1">
            {foot.map((line, i) => (
              <div key={i} className="truncate">
                {line || " "}
              </div>
            ))}
          </div>
          {fields.pageNumbers && <span style={{ color: PAPER.faint }}>1 / 1</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Settings > PDF templates > Letterheads (lib/letterheads): owners add, change and remove them and
 * pick the default; everyone else sees the list. The logo goes up through its own route once the
 * letterhead is saved.
 */
export function LetterheadsSettings({ workspaceId, letterheads, canEdit }: { workspaceId: string; letterheads: Letterhead[]; canEdit: boolean }) {
  const t = useTranslations("settings.letterheads");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The letterhead being edited: its id, "new", or none.
  const [editing, setEditing] = useState<string | null>(null);

  async function act(fn: () => Promise<{ ok: boolean; error?: string }>, done?: () => void) {
    setPending(true);
    setError(null);
    try {
      const result = await fn();
      if (!result.ok) setError(result.error ?? t("errors.notFound"));
      else {
        done?.();
        router.refresh();
      }
    } catch {
      setError(t("errors.notFound"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {letterheads.length === 0 && editing === null && <p className="px-5 py-4 text-sm text-fg-muted">{t("empty")}</p>}
      {letterheads.map((l) =>
        editing === l.id ? (
          <LetterheadForm key={l.id} initial={l} onCancel={() => setEditing(null)} onSaved={() => (setEditing(null), router.refresh())} />
        ) : (
          <div key={l.id} className="flex items-center gap-4 px-5 py-3">
            <LetterheadPreview fields={l} logo={logoUrl(l)} zoom={0.4} />
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{l.name}</span>
                {l.isDefault && <span className="shrink-0 text-xs text-fg-muted">{t("default")}</span>}
              </div>
              <div className="truncate text-fg-muted">{l.header.split("\n")[0] || t("noLines")}</div>
            </div>
            {canEdit && (
              <div className="flex shrink-0 gap-1">
                <IconButton
                  label={l.isDefault ? t("unsetDefault") : t("makeDefault")}
                  disabled={pending}
                  onClick={() => void act(() => setDefaultLetterheadAction(l.id, !l.isDefault))}
                >
                  {l.isDefault ? <StarOff className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />}
                </IconButton>
                <IconButton label={t("edit")} onClick={() => setEditing(l.id)} disabled={pending}>
                  <Pencil className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  label={t("remove", { name: l.name })}
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm(t("removeConfirm", { name: l.name }))) void act(() => deleteLetterheadAction(l.id));
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            )}
          </div>
        ),
      )}
      {editing === "new" && (
        <LetterheadForm workspaceId={workspaceId} initial={null} onCancel={() => setEditing(null)} onSaved={() => (setEditing(null), router.refresh())} />
      )}
      <div className="flex items-center gap-3 px-5 py-3 text-sm text-fg-muted">
        <span className="flex-1">{canEdit ? t("count", { count: letterheads.length, max: MAX_LETTERHEADS }) : t("ownersOnly")}</span>
        {error && editing === null && <span className="text-danger">{error}</span>}
        {canEdit && editing === null && (
          <Button size="sm" onClick={() => setEditing("new")} disabled={pending || letterheads.length >= MAX_LETTERHEADS}>
            <Plus className="h-3.5 w-3.5" />
            {t("add")}
          </Button>
        )}
      </div>
    </>
  );
}

/** A logo chosen in the form: a new file, or taking the current one off. */
type LogoChange = { file: File; url: string } | "remove" | null;

function LetterheadForm({
  workspaceId,
  initial,
  onCancel,
  onSaved,
}: {
  workspaceId?: string;
  initial: Letterhead | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("settings.letterheads");
  const tc = useTranslations("common");
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fields, setFields] = useState<LetterheadFields>(initial ?? EMPTY);
  const [logo, setLogo] = useState<LogoChange>(null);
  const [problem, setProblem] = useState<LetterheadProblem | "logoType" | "logoSize" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // A new letterhead once saved (its logo may still fail to go up): saving again changes it.
  const [savedId, setSavedId] = useState(initial?.id ?? null);
  const set = (patch: Partial<LetterheadFields>) => {
    setProblem(null);
    setFields((current) => ({ ...current, ...patch }));
  };
  const chosen = logo && logo !== "remove" ? logo.url : null;
  useEffect(() => () => void (chosen && URL.revokeObjectURL(chosen)), [chosen]);
  const shownLogo = useMemo(() => (logo === "remove" ? null : (chosen ?? (initial ? logoUrl(initial) : null))), [logo, chosen, initial]);

  async function pick(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) return setProblem("logoSize");
    if (!imageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()))) return setProblem("logoType");
    setProblem(null);
    setLogo({ file, url: URL.createObjectURL(file) });
  }

  async function save() {
    const parsed = parseLetterhead(fields);
    if (!parsed.ok) return setProblem(parsed.problem);
    setPending(true);
    setError(null);
    try {
      const result = savedId ? await updateLetterheadAction(savedId, parsed.fields) : await createLetterheadAction(workspaceId!, parsed.fields);
      if (!result.ok) return setError(result.error);
      setSavedId(result.data.id);
      if (logo) {
        const res = await fetch(`/api/letterheads/${result.data.id}/logo`, {
          method: logo === "remove" ? "DELETE" : "PUT",
          ...(logo === "remove" ? {} : { body: logo.file, headers: { "Content-Type": logo.file.type || "application/octet-stream" } }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setProblem(body?.error === "logoSize" ? "logoSize" : "logoType");
          return;
        }
      }
      onSaved();
    } catch {
      setError(t("errors.notFound"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="grid gap-5 bg-bg px-5 py-4 sm:grid-cols-[1fr_11rem]"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="space-y-4">
        <Field label={t("name")} htmlFor={`${id}-name`} error={problem === "name" ? t("errors.name") : null}>
          <Input id={`${id}-name`} value={fields.name} maxLength={MAX_LETTERHEAD_NAME} placeholder={t("namePlaceholder")} autoFocus onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field
          label={t("logo")}
          help={t("logoHelp", { size: formatBytes(MAX_LOGO_BYTES) })}
          error={problem === "logoType" || problem === "logoSize" ? t(`errors.${problem}`) : null}
        >
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileInput} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
            <Button onClick={() => fileInput.current?.click()} disabled={pending}>
              <ImageUp className="h-3.5 w-3.5" />
              {shownLogo ? t("replaceLogo") : t("uploadLogo")}
            </Button>
            {shownLogo && (
              <Button variant="ghost" onClick={() => setLogo(initial?.hasLogo ? "remove" : null)} disabled={pending}>
                <X className="h-3.5 w-3.5" />
                {t("removeLogo")}
              </Button>
            )}
            <select
              aria-label={t("logoPlace")}
              className={selectClass}
              value={fields.logoPlace}
              onChange={(e) => set({ logoPlace: e.target.value as LogoPlace })}
            >
              {LOGO_PLACES.map((place) => (
                <option key={place} value={place}>
                  {t(`places.${place}`)}
                </option>
              ))}
            </select>
          </div>
        </Field>
        <Field label={t("header")} htmlFor={`${id}-header`} help={t("headerHelp", { max: MAX_HEADER_LINES })} error={problem === "header" ? t("errors.header") : null}>
          <textarea
            id={`${id}-header`}
            className={textareaClass}
            rows={4}
            value={fields.header}
            placeholder={t("headerPlaceholder")}
            onChange={(e) => set({ header: e.target.value })}
          />
        </Field>
        <Field label={t("footer")} htmlFor={`${id}-footer`} help={t("footerHelp", { max: MAX_FOOTER_LINES })} error={problem === "footer" ? t("errors.footer") : null}>
          <textarea
            id={`${id}-footer`}
            className={textareaClass}
            rows={2}
            value={fields.footer}
            placeholder={t("footerPlaceholder")}
            onChange={(e) => set({ footer: e.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("accent")} help={t("accentHelp")} error={problem === "accent" ? t("errors.accent") : null}>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label={t("accent")}
                value={fields.accent || "#6b6d75"}
                onChange={(e) => set({ accent: e.target.value })}
                className="h-8 w-10 cursor-pointer rounded-md border border-border bg-bg p-0.5"
              />
              <Button variant="ghost" onClick={() => set({ accent: "" })} disabled={!fields.accent}>
                {t("noAccent")}
              </Button>
            </div>
          </Field>
          <Field label={t("pageNumbers")}>
            <div className="flex h-8 items-center">
              <Switch checked={fields.pageNumbers} onChange={(pageNumbers) => set({ pageNumbers })} label={t("pageNumbers")} />
            </div>
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2">
          {error && <span className="flex-1 text-sm text-danger">{error}</span>}
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? tc("saving") : tc("save")}
          </Button>
        </div>
      </div>
      <div className="order-first sm:order-none">
        <LetterheadPreview fields={fields} logo={shownLogo} className="mx-auto" />
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
