"use client";

import { Editor, Extension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { StarterKit } from "@tiptap/starter-kit";
import { Bold, Italic, Link2, List, ListOrdered, RemoveFormatting, Strikethrough, TextQuote, Underline } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn, IconButton, Popover } from "@/components/ui";
import { normalizeAddress } from "@/lib/mail";

/**
 * The Mail tab's editor: paragraphs, bold, italic, underline, strike, links, lists and quotes,
 * which is what server/mail-client/outgoing.ts lets through when it is sent. Other formatting
 * pasted in falls away as it comes. It is bound to React here rather than through TipTap's React
 * package: that package's module is shared with the page editor's first load, and what the
 * composer used of it would load there too.
 */

/** ⌘/Ctrl+Enter sends (the composer hears it), rather than breaking the line; ⌘/Ctrl+K adds a link. */
const Keys = Extension.create<{ onLink: () => void }>({
  name: "mailKeys",
  priority: 1000,
  addOptions: () => ({ onLink: () => {} }),
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => true,
      "Mod-k": () => {
        this.options.onLink();
        return true;
      },
    };
  },
});

/** The editor, made once in the browser from the first values given; `MailEditorContent` shows it. */
export function useMailEditor({ html, placeholder, label, onChange, autofocus }: { html: string; placeholder: string; label: string; onChange: (editor: Editor) => void; autofocus: "start" | "end" | false }) {
  const changed = useRef(onChange);
  changed.current = onChange;
  const first = useRef({ html, placeholder, label, autofocus });
  const [linking, setLinking] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    const { html, placeholder, label, autofocus } = first.current;
    const made = new Editor({
      element: null,
      autofocus,
      content: html,
      extensions: [
        StarterKit.configure({
          heading: false,
          code: false,
          codeBlock: false,
          horizontalRule: false,
          link: { openOnClick: false, autolink: true, defaultProtocol: "https", protocols: ["mailto"] },
        }),
        Placeholder.configure({ placeholder }),
        Keys.configure({ onLink: () => setLinking(true) }),
      ],
      editorProps: { attributes: { class: "mail-editor outline-none", "aria-label": label, "aria-multiline": "true", role: "textbox" } },
      onUpdate: ({ editor }) => changed.current(editor),
    });
    setEditor(made);
    return () => made.destroy();
  }, []);
  return { editor, linking, setLinking };
}

/** Where the editor shows: its view is made here and taken down when this goes, the text kept. */
export function MailEditorContent({ editor, className }: { editor: Editor | null; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editor || !host.current) return;
    editor.mount(host.current);
    return () => {
      if (!editor.isDestroyed) editor.unmount();
    };
  }, [editor]);
  return <div ref={host} className={cn("text-sm leading-relaxed [&_.ProseMirror]:min-h-full", className)} />;
}

const marks = (e: Editor) => ({
  bold: e.isActive("bold"),
  italic: e.isActive("italic"),
  underline: e.isActive("underline"),
  strike: e.isActive("strike"),
  bullets: e.isActive("bulletList"),
  numbers: e.isActive("orderedList"),
  quote: e.isActive("blockquote"),
  link: e.isActive("link"),
});

/** What is on where the caret is, read again after each change and kept as it was when nothing moved. */
function useActive(editor: Editor) {
  const [on, setOn] = useState(() => marks(editor));
  useEffect(() => {
    const update = () =>
      setOn((was) => {
        const now = marks(editor);
        return (Object.keys(now) as (keyof typeof now)[]).some((k) => now[k] !== was[k]) ? now : was;
      });
    update();
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);
  return on;
}

/** What a typed link goes to: an address as mailto:, anything else on the web. */
function linkHref(typed: string) {
  const value = typed.trim();
  if (!value) return null;
  if (/^(https?|mailto):/i.test(value)) return value;
  if (normalizeAddress(value)) return `mailto:${value}`;
  return `https://${value}`;
}

function Tool({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <IconButton
      label={label}
      aria-pressed={active}
      className={cn("h-8 w-8 text-fg-icon", active && "bg-bg-active text-fg")}
      // The editor keeps its selection: the click doesn't take the focus from it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </IconButton>
  );
}

/** The formatting buttons, shown beside Send once the editor is there. */
export function FormatBar({ editor, linking, setLinking }: { editor: Editor; linking: boolean; setLinking: (open: boolean) => void }) {
  const t = useTranslations("mail.composer");
  const on = useActive(editor);
  const [href, setHref] = useState("");
  const chain = () => editor.chain().focus();

  function applyLink() {
    const target = linkHref(href);
    const c = chain().extendMarkRange("link");
    if (!target) c.unsetLink().run();
    else if (editor.state.selection.empty && !editor.isActive("link")) c.insertContent({ type: "text", text: href.trim(), marks: [{ type: "link", attrs: { href: target } }] }).run();
    else c.setLink({ href: target }).run();
    setLinking(false);
  }

  return (
    <div className="flex flex-wrap items-center" role="toolbar" aria-label={t("formatting")}>
      <Tool label={t("bold")} active={on.bold} onClick={() => chain().toggleBold().run()}>
        <Bold className="h-4 w-4" />
      </Tool>
      <Tool label={t("italic")} active={on.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic className="h-4 w-4" />
      </Tool>
      <Tool label={t("underline")} active={on.underline} onClick={() => chain().toggleUnderline().run()}>
        <Underline className="h-4 w-4" />
      </Tool>
      <Tool label={t("strike")} active={on.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough className="h-4 w-4" />
      </Tool>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <Tool label={t("bullets")} active={on.bullets} onClick={() => chain().toggleBulletList().run()}>
        <List className="h-4 w-4" />
      </Tool>
      <Tool label={t("numbers")} active={on.numbers} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered className="h-4 w-4" />
      </Tool>
      <Tool label={t("quote")} active={on.quote} onClick={() => chain().toggleBlockquote().run()}>
        <TextQuote className="h-4 w-4" />
      </Tool>
      <Popover
        side="top"
        open={linking}
        onOpenChange={(open) => {
          if (open) setHref((editor.getAttributes("link").href as string | undefined)?.replace(/^mailto:/i, "") ?? "");
          setLinking(open);
        }}
        className="w-72 p-2"
        trigger={({ toggle }) => (
          <Tool label={t("link")} active={on.link} onClick={toggle}>
            <Link2 className="h-4 w-4" />
          </Tool>
        )}
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <input
            autoFocus
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setLinking(false);
                editor.commands.focus();
              }
            }}
            placeholder={t("linkPlaceholder")}
            aria-label={t("link")}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <button type="submit" className="h-8 shrink-0 rounded-md px-2 text-sm font-medium text-accent hover:bg-bg-hover">
            {href.trim() ? t("linkApply") : t("linkRemove")}
          </button>
        </form>
      </Popover>
      <Tool label={t("clearFormatting")} onClick={() => chain().unsetAllMarks().clearNodes().run()}>
        <RemoveFormatting className="h-4 w-4" />
      </Tool>
    </div>
  );
}
