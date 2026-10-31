"use client";

import purify from "dompurify";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { setMailboxSignatureAction } from "@/app/actions/row-mail";
import { FormatBar, MailEditorContent, useMailEditor } from "@/components/mail/mail-editor";
import { PastedSignatureView } from "@/components/mail/pasted-signature";
import { Button, cn } from "@/components/ui";
import { MAX_SIGNATURE_HTML, type MailboxView } from "@/lib/mail";
import { pastedHtml, RICH_PASTE, wrapPasted } from "@/lib/pasted-signature";
import { PASTED_SIGNATURE_CONFIG } from "@/lib/pasted-signature-config";
import { useAction } from "./workspace-settings";

/**
 * A mailbox's signature written in the Mail tab's editor, with the same formatting a message has
 * (the server keeps only that), or pasted from another mail program with its images and layout,
 * which is kept as it came (lib/pasted-signature.ts). Saving it empty takes it away.
 */
export function SignatureEditor({ mailbox, onSaved, onCancel }: { mailbox: MailboxView; onSaved: (mailbox: MailboxView) => void; onCancel: () => void }) {
  const t = useTranslations("account.mail");
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  const [pasted, setPasted] = useState(() => pastedHtml(mailbox.signature));
  const [tooLarge, setTooLarge] = useState(false);
  const pastedBox = useRef<HTMLDivElement>(null);
  const { editor, linking, setLinking } = useMailEditor({
    html: pastedHtml(mailbox.signature) === null ? (mailbox.signature ?? "") : "",
    placeholder: t("signaturePlaceholder"),
    label: t("signatureFor", { address: mailbox.address }),
    autofocus: false,
    onChange: () => {},
  });
  // Written into as it opens and as one kind gives way to the other: the view is in place once the
  // editor is (MailEditorContent mounts it first, and keeps it while a pasted one shows).
  const writing = pasted === null;
  useEffect(() => {
    if (writing) editor?.commands.focus("end");
    else pastedBox.current?.focus();
  }, [editor, writing]);

  // Taken before the editor sees it: a signature with images or a layout the editor would drop.
  const takePaste = (e: ClipboardEvent<HTMLElement>) => {
    const html = e.clipboardData.getData("text/html");
    if (!RICH_PASTE.test(html)) return;
    e.preventDefault();
    e.stopPropagation();
    setTooLarge(false);
    setPasted((purify.sanitize(html, PASTED_SIGNATURE_CONFIG) as string).trim());
  };
  const save = () => {
    const html = pasted !== null ? wrapPasted(pasted) : !editor || editor.isEmpty ? "" : editor.getHTML();
    if (html.length > MAX_SIGNATURE_HTML) return setTooLarge(true);
    run(() => setMailboxSignatureAction(mailbox.id, html), onSaved);
  };

  return (
    <div
      className="space-y-3"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
      }}
    >
      {pasted !== null && (
        <div ref={pastedBox} tabIndex={0} onPaste={takePaste} aria-label={t("signatureFor", { address: mailbox.address })} className="rounded-md border border-border bg-bg outline-none focus:border-accent">
          <div className="px-3 py-3">
            <PastedSignatureView html={pasted} />
          </div>
          <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 border-t border-border py-1 ps-3 pe-1 text-xs text-fg-muted">
            <span>{t("signaturePasted")}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPasted(null);
                setTooLarge(false);
                editor?.commands.clearContent();
              }}
            >
              {t("signatureWrite")}
            </Button>
          </div>
        </div>
      )}
      {/* Kept in place while a pasted one shows: taking its view down and putting it up again loses the focus given to it. */}
      <div className={cn("rounded-md border border-border bg-bg focus-within:border-accent", pasted !== null && "hidden")} onPasteCapture={takePaste}>
        <div className="cursor-text px-3 py-2" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), editor?.commands.focus("end"))}>
          <MailEditorContent editor={editor} className="[&_.ProseMirror]:min-h-[3lh]" />
        </div>
        <div className="flex min-h-9 items-center border-t border-border px-1">{editor && <FormatBar editor={editor} linking={linking} setLinking={setLinking} />}</div>
      </div>
      {(tooLarge || error) && <p className="text-sm text-danger">{tooLarge ? t("signatureTooLarge") : error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel} disabled={pending}>
          {tc("cancel")}
        </Button>
        <Button size="sm" variant="primary" onClick={save} disabled={pending || !editor}>
          {tc("save")}
        </Button>
      </div>
    </div>
  );
}
