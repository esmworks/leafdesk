/**
 * The Mail tab (server/mail-client): a member reads and writes the mail of their own mailboxes in
 * Leafdesk. The headers of each folder are kept so the list opens at once; bodies and attachments
 * are read from the mail server when a message is opened. Shared by the client and the server.
 */

import type { MailImagesFrom } from "./mail-images";

/** What a folder is for. Folders without one are the owner's own. */
export type MailFolderRole = "inbox" | "sent" | "drafts" | "archive" | "junk" | "trash";

export const MAIL_FOLDER_ROLES: MailFolderRole[] = ["inbox", "drafts", "sent", "archive", "junk", "trash"];

export type MailAddress = { address: string; name: string | null };

/** Messages of a thread list page. */
export const MAIL_PAGE = 50;
/** How far back a folder is read the first time: days, and messages at most. */
export const MAIL_BACKFILL_DAYS = 90;
export const MAIL_BACKFILL_LIMIT = { role: 2000, own: 500 };
/** Folders of a mailbox the Mail tab lists at most. */
export const MAX_MAIL_FOLDERS = 60;
/** Characters of a message's text kept for the list. */
export const MAIL_PREVIEW_CHARS = 200;
/** A reply without references joins the newest thread of the same subject within this many days. */
export const SUBJECT_THREAD_DAYS = 30;
/** Seconds an archive or a deletion waits, so Undo can take it back before the mail server hears of it. */
export const MAIL_UNDO_SECONDS = 5;
/** Recipients a message from the Mail tab may have, To, Cc and Bcc together. */
export const MAX_MAIL_RECIPIENTS = 100;
/** Attachments a message from the Mail tab may bring, together. */
export const MAX_COMPOSE_BYTES = 20 * 1024 * 1024;
/** The HTML a message from the Mail tab may have, before it is cleaned. */
export const MAX_MAIL_HTML = 1_000_000;

/** A folder as the server lists it (imapflow's ListResponse, the parts that count here). */
export type ListedMailFolder = { path: string; name: string; delimiter?: string | null; parent: string[]; flags: Set<string>; specialUse?: string | null };

const SPECIAL_USE: Record<string, MailFolderRole> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Archive": "archive",
  "\\Junk": "junk",
  "\\Trash": "trash",
};

/** Marks of folders that only show other folders' messages again (Gmail's All Mail, Starred, Important). */
const MIRRORS = ["\\All", "\\Flagged", "\\Important"];

/**
 * Names a folder goes by when the server doesn't mark what it is for, in the languages Leafdesk
 * speaks. Sent folders are found by server/row-mail/connect.ts `guessSentFolder` as well.
 */
const ROLE_NAMES: Record<Exclude<MailFolderRole, "inbox">, string[]> = {
  sent: ["Sent", "Sent Items", "Sent Messages", "Sent Mail", "Gönderilenler", "Gönderilmiş Öğeler", "Gönderilen Öğeler", "Gönderilen", "Gesendet", "Gesendete Elemente", "Enviados", "Elementos enviados", "Envoyés", "Éléments envoyés", "Inviati", "Posta inviata", "Itens enviados", "Wysłane", "Отправленные", "Надіслані", "المرسلة", "ارسال شده", "נשלחו", "送信済み", "보낸 편지함", "已发送", "已傳送", "寄件備份"],
  drafts: ["Drafts", "Draft", "Taslaklar", "Taslak", "Entwürfe", "Borradores", "Brouillons", "Bozze", "Rascunhos", "Wersje robocze", "Черновики", "Чернетки", "المسودات", "پیش‌نویس‌ها", "טיוטות", "下書き", "임시 보관함", "草稿", "草稿箱"],
  archive: ["Archive", "Archives", "Arşiv", "Arşivle", "Archiv", "Archivo", "Archivio", "Arquivo", "Archiwum", "Архив", "Архів", "الأرشيف", "بایگانی", "ארכיון", "アーカイブ", "보관함", "归档", "封存"],
  junk: ["Junk", "Junk E-mail", "Junk Email", "Spam", "Bulk Mail", "Gereksiz", "Gereksiz E-posta", "İstenmeyen", "İstenmeyen E-posta", "Önemsiz E-posta", "Spam-Verdacht", "Junk-E-Mail", "Correo no deseado", "Courrier indésirable", "Indesiderata", "Lixo eletrônico", "Wiadomości-śmieci", "Спам", "البريد العشوائي", "هرزنامه", "דואר זבל", "迷惑メール", "스팸", "垃圾邮件", "垃圾郵件"],
  trash: ["Trash", "Deleted", "Deleted Items", "Deleted Messages", "Bin", "Çöp", "Çöp Kutusu", "Silinmiş Öğeler", "Silinenler", "Papierkorb", "Gelöschte Elemente", "Papelera", "Elementos eliminados", "Corbeille", "Éléments supprimés", "Cestino", "Lixeira", "Itens excluídos", "Kosz", "Корзина", "Удаленные", "Кошик", "المهملات", "سطل زباله", "אשפה", "ゴミ箱", "削除済みアイテム", "휴지통", "已删除", "垃圾桶", "已刪除"],
};

/** A folder name as compared: case, accents, spaces, dashes and invisible marks don't count. */
export const folderNameKey = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\p{M}\s​-‏._-]+/gu, "");

const NAME_ROLE = new Map<string, Exclude<MailFolderRole, "inbox">>();
for (const [role, names] of Object.entries(ROLE_NAMES) as [Exclude<MailFolderRole, "inbox">, string[]][]) {
  for (const name of names) if (!NAME_ROLE.has(folderNameKey(name))) NAME_ROLE.set(folderNameKey(name), role);
}

/** Whether the Mail tab lists a folder: not one that can't be opened, nor one that only mirrors others. */
export function listsFolder(folder: ListedMailFolder) {
  if (folder.flags.has("\\Noselect") || folder.flags.has("\\NonExistent")) return false;
  if (folder.specialUse && MIRRORS.includes(folder.specialUse)) return false;
  return !MIRRORS.some((mark) => folder.flags.has(mark));
}

/**
 * What each listed folder is for: the server's marks first, then names, which count only at the
 * top or right under the inbox or Gmail's folder (deeper down is somebody's own filing). One folder
 * per role, the marked one or the shallowest.
 */
export function folderRoles(folders: ListedMailFolder[]): Map<string, MailFolderRole> {
  const roles = new Map<string, MailFolderRole>();
  const taken = new Set<MailFolderRole>();
  for (const folder of folders) {
    const role = folder.path.toUpperCase() === "INBOX" ? "inbox" : folder.specialUse ? SPECIAL_USE[folder.specialUse] : undefined;
    if (role && !taken.has(role)) {
      roles.set(folder.path, role);
      taken.add(role);
    }
  }
  const byName = folders
    .filter((f) => !roles.has(f.path) && !f.specialUse)
    .flatMap((folder) => {
      const role = NAME_ROLE.get(folderNameKey(folder.name));
      const depth = folder.parent.length;
      const under = depth === 1 && ["INBOX", "[GMAIL]", "[GOOGLE MAIL]"].includes(folder.parent[0].toUpperCase());
      return role && (depth === 0 || under) ? [{ folder, role, depth }] : [];
    })
    .sort((a, b) => a.depth - b.depth);
  for (const { folder, role } of byName) {
    if (taken.has(role)) continue;
    roles.set(folder.path, role);
    taken.add(role);
  }
  return roles;
}

/** A subject as threads compare it: no Re:, Fwd: or their translations in front, one space, lower case. */
export function subjectKey(subject: string) {
  let s = subject.normalize("NFC").trim();
  for (;;) {
    const next = s.replace(/^((re|aw|sv|vs|ynt|antw|res|rif|odp|fw|fwd|wg|tr|enc|[iİı]lt|rv)(\[\d+\])?\s*[:：]\s*)/iu, "").replace(/^\[[^\]]{1,40}\]\s*/, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").toLocaleLowerCase("en").slice(0, 300);
}

/** Whether a subject says it answers or forwards another message. */
export const isReplySubject = (subject: string) => subjectKey(subject) !== subject.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en").slice(0, 300);

/** "Fwd: " in front of a subject, once. */
export function forwardSubject(subject: string) {
  return /^\s*(fwd?|wg|tr|[iİı]lt|enc)\s*:/iu.test(subject) ? subject : `Fwd: ${subject}`;
}

/** The text a list shows of a message: one line, without quoted earlier mail, cut to MAIL_PREVIEW_CHARS. */
export function previewText(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    // Where the earlier message starts ("On … wrote:", "> …", a forwarded block) the preview ends.
    if (/^-{2,}\s*(original message|forwarded message|orijinal ileti|iletilen ileti)/i.test(line)) break;
    if (/^\s*>/.test(line)) {
      // The line naming who wrote it goes too, in whatever language: the one ending in a colon above the quote.
      while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
      if (kept.length && /:\s*$/.test(kept[kept.length - 1])) kept.pop();
      break;
    }
    kept.push(line);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim().slice(0, MAIL_PREVIEW_CHARS);
}

/** What the search box asks for, read from what was typed (`from:`, `is:unread` …, the rest as words). */
export type MailQuery = {
  words: string[];
  from?: string;
  to?: string;
  subject?: string;
  unread?: boolean;
  starred?: boolean;
  attachment?: boolean;
  after?: string;
  before?: string;
};

/** Reads the search box: `key:value` and `key:"two words"` for the keys above, quoted phrases and words. */
export function parseMailQuery(input: string): MailQuery {
  const query: MailQuery = { words: [] };
  const tokens = input.match(/(\w+:"[^"]*"|\w+:\S+|"[^"]*"|\S+)/g) ?? [];
  for (const token of tokens) {
    const colon = token.indexOf(":");
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    const value = (colon > 0 ? token.slice(colon + 1) : token).replace(/^"|"$/g, "").trim();
    if (!value) continue;
    if (key === "from" || key === "kimden") query.from = value;
    else if (key === "to" || key === "kime") query.to = value;
    else if (key === "subject" || key === "konu") query.subject = value;
    else if ((key === "is" || key === "durum") && /^(unread|okunmamış|okunmamis)$/i.test(value)) query.unread = true;
    else if ((key === "is" || key === "durum") && /^(read|okunmuş|okunmus)$/i.test(value)) query.unread = false;
    else if ((key === "is" || key === "durum") && /^(starred|yıldızlı|yildizli)$/i.test(value)) query.starred = true;
    else if ((key === "has" || key === "var") && /^(attachment|ek)$/i.test(value)) query.attachment = true;
    else if ((key === "after" || key === "sonra") && /^\d{4}-\d{2}-\d{2}$/.test(value)) query.after = value;
    else if ((key === "before" || key === "önce" || key === "once") && /^\d{4}-\d{2}-\d{2}$/.test(value)) query.before = value;
    else query.words.push(colon > 0 && !key ? token : value);
  }
  return query;
}

/** A folder in the Mail tab's sidebar. */
export type MailFolderView = { id: string; path: string; name: string; role: MailFolderRole | null; unseen: number; total: number; depth: number };

/** One of the person's mailboxes in the workspace, as the Mail tab shows it. */
export type MailboxTabView = {
  id: string;
  address: string;
  displayName: string | null;
  isDefault: boolean;
  status: "connecting" | "ok" | "error";
  statusError: string | null;
  /** Null until its folders were first read. */
  folders: MailFolderView[] | null;
  syncedAt: string | null;
  /** What the person signs with from it, as the editor's HTML; null for none. */
  signature: string | null;
};

/** A thread in a folder's list. */
export type MailThreadItem = {
  threadId: string;
  /** The newest message of the thread in this folder, which opening the thread starts from. */
  messageId: string;
  /** Senders of the thread's messages, newest first, each once. */
  senders: MailAddress[];
  subject: string;
  preview: string;
  sentAt: string;
  count: number;
  unread: boolean;
  /** Its messages here, and how many of them are unread: what reading or moving it changes in the folder's count. */
  held: number;
  unseen: number;
  starred: boolean;
  hasAttachments: boolean;
  hasDraft: boolean;
  /** The database row the other party is (its title and database), when one is. */
  row: { rowId: string; databaseId: string; title: string; icon: string | null } | null;
};

export type MailThreadPage = { items: MailThreadItem[]; next: string | null };

/** An attachment of an opened message, downloaded from the mail server when asked. */
export type MailAttachmentView = { part: string; name: string; contentType: string; size: number; contentId: string | null; inline: boolean };

/** A message of an opened thread. Bodies come with the newest one and any asked for. */
export type MailMessageView = {
  id: string;
  folderId: string;
  folderRole: MailFolderRole | null;
  messageId: string | null;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  preview: string;
  sentAt: string;
  seen: boolean;
  flagged: boolean;
  draft: boolean;
  hasAttachments: boolean;
  /** Read from the mail server: null until then, or when the message is gone from it. */
  body: MailBody | null;
};

export type MailBody = {
  text: string;
  /** Cleaned HTML (server/mail-client/html.ts), with remote images left out unless asked for. */
  html: string | null;
  /** The earlier mail the HTML quotes at its end, taken out of it to show when asked for. */
  quotedHtml: string | null;
  /** Remote images the HTML would load, left out. */
  blockedImages: number;
  /** Why remote images load in the HTML (lib/mail-images.ts); null while they are left out. */
  images: MailImagesFrom | null;
  attachments: MailAttachmentView[];
  replyTo: MailAddress[];
  /** The provider's check said the sender's domain did not vouch for it (DMARC failed). */
  unverifiedSender: boolean;
  /** The List-Unsubscribe address, when the message offers one over the web. */
  unsubscribe: string | null;
};

export type MailThreadView = {
  threadId: string;
  subject: string;
  messages: MailMessageView[];
  row: MailThreadItem["row"];
};

/** A message written in the Mail tab. */
export type MailDraftInput = {
  mailboxId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** What the editor wrote (server/mail-client/outgoing.ts keeps its formatting); `text` without it. */
  html?: string;
  text?: string;
  /** The opened message this answers or forwards, by its id in the index. */
  replyTo?: string | null;
  forward?: string | null;
  /** The draft it was saved as last (or opened from), which saving again or sending replaces. */
  draft?: MailDraftRef | null;
  /**
   * The earlier mail goes under what was written: the quote of the draft before when it has one,
   * else the message it answers or forwards under `header` (who wrote it when, a forward's header).
   */
  quote?: { header: string[] | null } | null;
};

/**
 * A draft the composer saved or opened: its id in the index (null when the index hasn't read it),
 * its Message-ID, which finds its copies on the mail server, and the parts of its files kept.
 */
export type MailDraftRef = { id: string | null; messageId: string | null; keep: string[]; mailboxId?: string };

/** A message sent from the Mail tab, waiting MAIL_UNDO_SECONDS on the server for Undo. */
export type MailHeldSend = { sendId: string };
/** A send undone: the draft it went back to (its id in the index, when known) and the message it answers. */
export type MailUndoneSend = { id: string | null; replyTo: string | null };
/** How a held send went; `error` is said for its sender when it failed (it is kept as a draft then). */
export type MailSendStatus = { state: "held" | "sending" | "sent" | "undone" | "failed" | "gone"; error: string | null };

/** A draft just saved in the mailbox's drafts folder. */
export type MailSavedDraft = { id: string | null; messageId: string; attachments: MailAttachmentView[] };

/** A draft opened to write on again. */
export type MailDraftView = {
  id: string;
  mailboxId: string;
  messageId: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  /** What it says, as the editor reads it. */
  html: string;
  /** The message it answers, by its id in the index, when the index has it. */
  replyTo: string | null;
  attachments: MailAttachmentView[];
  /** The earlier mail it carries under what is written (server/mail-client/quote.ts), cleaned to show; null without. */
  quote: string | null;
};

/** A draft is saved this long after the last change, or, with files of more than MAIL_DRAFT_HEAVY bytes, MAIL_DRAFT_SLOW_MS. */
export const MAIL_DRAFT_SAVE_MS = 3000;
export const MAIL_DRAFT_SLOW_MS = 15_000;
export const MAIL_DRAFT_HEAVY = 2 * 1024 * 1024;

/** Actions on threads from the list or an opened thread. */
/** `move` goes to the folder the request names in `to`; the others are by folder role or flag. */
export type MailAction = "archive" | "trash" | "junk" | "inbox" | "move" | "read" | "unread" | "star" | "unstar" | "delete";
/** Folders a conversation can be moved to by name: not where mail is written or sent from. */
export const movableTo = (folder: { role: MailFolderRole | null }) => folder.role !== "sent" && folder.role !== "drafts";
