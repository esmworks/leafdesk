"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { quickNoteTargetsAction, saveVoiceNoteAction } from "@/app/actions/ai";
import { createPageAction } from "@/app/actions/pages";
import { saveWebPageAction, webClipTargetsAction, type WebClipSetup } from "@/app/actions/web-clip";
import { Button, buttonClass, cn, Input, pageLabel, selectClass, textareaClass } from "@/components/ui";
import { VoiceNoteRecorder } from "@/components/voice/voice-note-recorder";
import { startingTarget, validTarget, WebClipTargetPicker } from "@/components/workspace/web-clip";
import { SHARED_COOKIE, SHARED_COOKIE_PATH } from "@/lib/shared-note";
import type { VoiceNoteDraft, VoiceNoteLimits } from "@/lib/voice-notes";
import type { TreeNode } from "@/server/pages";

/** A shared web page that can be saved whole (see server/web-clip.ts): where to, in the first workspace. */
export type SharedWebPage = { url: string; quote: string; tree: TreeNode[]; setup: WebClipSetup };

export type QuickNoteTargets = {
  limits: VoiceNoteLimits | null;
  /** `instructions`: the database has writing instructions its voice notes follow. */
  databases: { id: string; title: string; icon: string | null; instructions: boolean }[];
};

/**
 * The quick note's fields (see app/share): saved as a private page, or as a row of a database the
 * person picks, then opened. Where the server can transcribe, a voice note fills the fields: the
 * AI's write-up of the recording, which the person can change before saving; its transcript is
 * saved under the note. A shared link can be saved as the whole page instead (`webPage`): its text
 * and pictures, under a page, into a database or as a private page, where the person saved the
 * last time unless they pick another place.
 */
export function QuickNoteForm({
  workspaces,
  workspaceId: initialWorkspace,
  title: initialTitle,
  body: initialBody,
  targets: initialTargets,
  voice: startVoice,
  webPage: initialWebPage = null,
}: {
  workspaces: { id: string; name: string }[];
  workspaceId: string;
  title: string;
  body: string;
  /** Voice notes and databases of the first workspace (later ones are loaded when chosen). */
  targets: QuickNoteTargets;
  /** Opened from the "Voice note" shortcut: start recording right away. */
  voice: boolean;
  /** What was shared has a web address: offered to save whole. */
  webPage?: SharedWebPage | null;
}) {
  const t = useTranslations("page.quickNote");
  const tv = useTranslations("page.voiceNote");
  const tc = useTranslations("common");
  const router = useRouter();
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace);
  const [targets, setTargets] = useState<QuickNoteTargets>(initialTargets);
  const [databaseId, setDatabaseId] = useState("");
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  /** The voice note in the fields, with the database its properties were picked for. */
  const [draft, setDraft] = useState<(VoiceNoteDraft & { databaseId: string }) | null>(null);
  const [recording, setRecording] = useState(false);
  /** The "Voice note" shortcut records once, when the page opens; not again on another workspace. */
  const [autoVoice, setAutoVoice] = useState(startVoice);
  const chosenWorkspace = useRef(initialWorkspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webPage, setWebPage] = useState(initialWebPage);
  /** Where the whole page goes; null until the person picks (the starting target then). */
  const [webTarget, setWebTarget] = useState<string | null>(null);
  const [webError, setWebError] = useState<string | null>(null);

  // What was shared is in the fields now: the cookie that brought it (app/api/share) goes.
  useEffect(() => {
    document.cookie = `${SHARED_COOKIE}=; Max-Age=0; Path=${SHARED_COOKIE_PATH}${location.protocol === "https:" ? "; Secure" : ""}`;
  }, []);

  // A voice note in the fields stays: its transcript is saved with it in the new workspace too, and
  // properties picked for a database of the old one are left out (see save).
  const chooseWorkspace = async (id: string) => {
    chosenWorkspace.current = id;
    setWorkspaceId(id);
    setDatabaseId("");
    setAutoVoice(false);
    setTargets({ limits: null, databases: [] });
    setWebTarget(null);
    const [result, web] = await Promise.all([quickNoteTargetsAction(id), webPage ? webClipTargetsAction(id) : null]);
    // Another workspace was chosen while this one's answer was on its way.
    if (chosenWorkspace.current !== id) return;
    if (result.ok) setTargets(result.data);
    if (web?.ok && webPage) setWebPage({ ...webPage, tree: web.data.tree, setup: web.data });
  };

  const webChosen = webPage ? (webTarget ?? startingTarget(webPage.tree, webPage.setup)) : "";
  const webValid = webPage !== null && validTarget(webPage.tree, webPage.setup.topLevel, webChosen);

  const saveWhole = async () => {
    if (!webPage) return;
    setBusy(true);
    setWebError(null);
    try {
      const result = await saveWebPageAction({ workspaceId, url: webPage.url, targetId: webChosen || null, quote: webPage.quote });
      if (!result.ok) throw new Error(result.error);
      router.push(`/w/${workspaceId}/p/${result.data.page.id}`);
    } catch (caught) {
      setWebError(caught instanceof Error && caught.message ? caught.message : tc("genericError"));
      setBusy(false);
    }
  };

  const onDraft = useCallback(
    (next: VoiceNoteDraft) => {
      setDraft({ ...next, databaseId });
      setTitle(next.title);
      setBody(next.markdown);
    },
    [databaseId],
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let id: string;
      if (draft) {
        const result = await saveVoiceNoteAction({
          workspaceId,
          databaseId: databaseId || null,
          title: title.trim(),
          markdown: body,
          transcript: draft.transcript,
          // Values picked for another database don't fit this one.
          properties: draft.databaseId === databaseId ? draft.properties : {},
        });
        if (!result.ok) throw new Error(result.error);
        id = result.data.id;
      } else {
        // A private page at the top of the workspace, or a row of the database.
        ({ id } = await createPageAction({ workspaceId, title: title.trim(), markdown: body, teamspaceId: null, parentId: databaseId || null }));
      }
      router.push(`/w/${workspaceId}/p/${id}`);
    } catch (caught) {
      setError(draft && caught instanceof Error && caught.message ? caught.message : tc("genericError"));
      setBusy(false);
    }
  };

  const picked = draft && draft.databaseId === databaseId ? Object.keys(draft.properties).length : 0;
  const followsInstructions = Boolean(targets.limits && databaseId && targets.databases.find((d) => d.id === databaseId)?.instructions);

  return (
    <form
      className="mt-5 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {workspaces.length > 1 && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t("workspace")}</span>
          <select
            value={workspaceId}
            onChange={(e) => void chooseWorkspace(e.target.value)}
            disabled={recording}
            className={cn(selectClass, "w-full")}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {webPage && (
        <div className="space-y-3 rounded-lg border border-border bg-bg-subtle p-3">
          <div>
            <p className="text-sm font-medium">{t("fullPage.heading")}</p>
            <p className="mt-0.5 truncate text-xs text-fg-muted" title={webPage.url}>
              {webPage.url}
            </p>
            <p className="mt-1 text-xs text-fg-muted">{t("fullPage.help")}</p>
          </div>
          <WebClipTargetPicker
            tree={webPage.tree}
            topLevel={webPage.setup.topLevel}
            value={webChosen}
            onChange={setWebTarget}
            disabled={busy || recording}
          />
          {webError && (
            <p role="alert" className="text-xs text-danger">
              {webError}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="secondary" disabled={busy || recording || !webValid} onClick={() => void saveWhole()}>
              {t("fullPage.save")}
            </Button>
          </div>
        </div>
      )}
      {targets.databases.length > 0 && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t("destination")}</span>
          <select value={databaseId} onChange={(e) => setDatabaseId(e.target.value)} disabled={recording} className={cn(selectClass, "w-full")}>
            <option value="">{t("privatePage")}</option>
            {targets.databases.map((d) => (
              <option key={d.id} value={d.id}>
                {d.icon ? `${d.icon} ` : ""}
                {pageLabel(d.title)}
              </option>
            ))}
          </select>
        </label>
      )}
      {targets.limits && (
        <div className="rounded-lg border border-dashed border-border p-3">
          <VoiceNoteRecorder
            key={workspaceId}
            limits={targets.limits}
            fields={{ workspaceId, databaseId }}
            onDraft={onDraft}
            autoStart={autoVoice}
            onBusyChange={setRecording}
          />
          {followsInstructions && <p className="mt-2 text-xs text-fg-muted">{tv("instructions.followed")}</p>}
        </div>
      )}
      <label className="block">
        <span className="mb-1 block text-sm font-medium">{t("title")}</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tc("untitled")} autoFocus={!initialTitle && !startVoice} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">{t("body")}</span>
        <textarea
          rows={draft ? 12 : 8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("bodyPlaceholder")}
          className={textareaClass}
        />
      </label>
      {draft && (
        <p className="text-xs text-fg-muted" aria-live="polite">
          {draft.rewritten ? tv("review") : tv("notRewritten")} {tv("transcriptKept")}
          {picked > 0 && ` ${tv("propertiesPicked", { count: picked })}`}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <a href={`/w/${workspaceId}`} className={buttonClass({ variant: "ghost" })}>
          {tc("cancel")}
        </a>
        <Button type="submit" variant="primary" disabled={busy || recording || (!title.trim() && !body.trim())}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
