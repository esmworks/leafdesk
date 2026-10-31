"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { setMailboxSignatureAction } from "@/app/actions/row-mail";
import { FormatBar, MailEditorContent, useMailEditor } from "@/components/mail/mail-editor";
import { Button } from "@/components/ui";
import type { MailboxView } from "@/lib/mail";
import { useAction } from "./workspace-settings";

/**
 * A mailbox's signature written in the Mail tab's editor, with the same formatting a message has
 * (the server keeps only that). Saving it empty takes it away.
 */
export function SignatureEditor({ mailbox, onSaved, onCancel }: { mailbox: MailboxView; onSaved: (mailbox: MailboxView) => void; onCancel: () => void }) {
  const t = useTranslations("account.mail");
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  const { editor, linking, setLinking } = useMailEditor({
    html: mailbox.signature ?? "",
    placeholder: t("signaturePlaceholder"),
    label: t("signatureFor", { address: mailbox.address }),
    autofocus: false,
    onChange: () => {},
  });
  // Written into as it opens: the view is in place once the editor is (MailEditorContent mounts it first).
  useEffect(() => {
    editor?.commands.focus("end");
  }, [editor]);
  const save = () => run(() => setMailboxSignatureAction(mailbox.id, !editor || editor.isEmpty ? "" : editor.getHTML()), onSaved);

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
      <div className="rounded-md border border-border bg-bg focus-within:border-accent">
        <div className="cursor-text px-3 py-2" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), editor?.commands.focus("end"))}>
          <MailEditorContent editor={editor} className="[&_.ProseMirror]:min-h-20" />
        </div>
        <div className="flex min-h-9 items-center border-t border-border px-1">{editor && <FormatBar editor={editor} linking={linking} setLinking={setLinking} />}</div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
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
