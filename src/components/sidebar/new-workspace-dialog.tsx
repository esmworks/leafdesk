"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState, useTransition } from "react";
import { listKitsAction } from "@/app/actions/templates";
import { createWorkspaceAction } from "@/app/actions/workspaces";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogTitle, Input } from "@/components/ui";
import type { BuiltinTemplateKey } from "@/lib/builtin-templates";
import { RestoreBackup } from "./restore-backup";

type Kit = { key: BuiltinTemplateKey; title: string; description: string; icon: string };

export function NewWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const t = useTranslations("sidebar.newWorkspace");
  const tc = useTranslations("common");
  const ids = useId();
  const [name, setName] = useState("");
  // What the workspace starts with: nothing (null) or one of the gallery's kits.
  const [kits, setKits] = useState<Kit[]>([]);
  const [template, setTemplate] = useState<BuiltinTemplateKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Made, but its template couldn't be set up: the dialog says so and opens it on request.
  const [madeEmpty, setMadeEmpty] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    if (!open) return;
    void listKitsAction().then((result) => {
      if (result.ok) setKits(result.data);
    });
  }, [open]);

  function close() {
    // A restore can't be called off halfway; the dialog stays until it's over.
    if (restoring) return;
    setName("");
    setTemplate(null);
    setError(null);
    setMadeEmpty(null);
    setRestored(false);
    onClose();
  }

  function openWorkspace(path: string) {
    close();
    router.push(path);
  }

  const choices: { key: BuiltinTemplateKey | null; icon: string | null; title: string; description: string }[] = [
    { key: null, icon: null, title: t("empty"), description: t("emptyDescription") },
    ...kits,
  ];

  return (
    <Dialog open={open} onClose={close} className="max-w-md">
      {madeEmpty ? (
        <>
          <DialogBody className="pt-5">
            <DialogTitle>{t("title")}</DialogTitle>
            <p role="alert" className="text-sm text-danger">
              {t("templateFailed")}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="primary" onClick={() => openWorkspace(`/w/${madeEmpty}`)}>
              {t("restore.open")}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <>
          <DialogBody className="pt-5">
            {/* Its buttons are in the footer, outside it, so the backup restore can stay under the fields. */}
            <form
              id={`${ids}-form`}
              className={restored ? "hidden" : "space-y-4"}
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                startTransition(async () => {
                  const result = await createWorkspaceAction(name, template);
                  if (!result.ok) return setError(result.error);
                  const { workspaceId, pageId } = result.data;
                  if (template && !pageId) return setMadeEmpty(workspaceId);
                  openWorkspace(pageId ? `/w/${workspaceId}/p/${pageId}` : `/w/${workspaceId}`);
                });
              }}
            >
              <div className="space-y-1.5">
                <DialogTitle>{t("title")}</DialogTitle>
                <p className="text-sm text-fg-muted">{t("description")}</p>
              </div>
              <Input autoFocus placeholder={t("namePlaceholder")} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              {kits.length > 0 && (
                <fieldset className="space-y-1.5">
                  <legend className="mb-1.5 text-sm font-medium">{t("startWith")}</legend>
                  {choices.map((choice) => (
                    <label
                      key={choice.key ?? ""}
                      className={cn(
                        "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2",
                        template === choice.key ? "border-accent" : "border-border hover:bg-bg-hover",
                      )}
                    >
                      <input
                        type="radio"
                        name={`${ids}-template`}
                        className="mt-1 accent-[var(--accent)]"
                        checked={template === choice.key}
                        onChange={() => setTemplate(choice.key)}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm">
                          {choice.icon && <span className="me-1.5">{choice.icon}</span>}
                          {choice.title}
                        </span>
                        <span className="block text-xs text-fg-muted">{choice.description}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              {error && <p className="text-xs text-danger">{error}</p>}
            </form>
            <RestoreBackup onBusy={setRestoring} onRestored={() => setRestored(true)} onDone={close} />
          </DialogBody>
          {!restored && (
            <DialogFooter>
              <Button variant="secondary" onClick={close}>
                {tc("cancel")}
              </Button>
              <Button type="submit" form={`${ids}-form`} variant="primary" disabled={pending || !name.trim()}>
                {pending ? t("creating") : t("create")}
              </Button>
            </DialogFooter>
          )}
        </>
      )}
    </Dialog>
  );
}
