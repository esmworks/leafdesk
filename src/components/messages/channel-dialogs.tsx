"use client";

import { Archive, Bell, Hash, Lock, LogOut, Search, Shield, UserMinus, UserPlus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { showToast } from "@/components/toast";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader, Input, selectClass, Switch, textareaClass } from "@/components/ui";
import type { ChannelView } from "@/lib/message-wire";
import { channelName, channelNameError, MESSAGE_LIMITS, messagesPath, type ChannelNotify } from "@/lib/messages";
import { ChannelWebhooks } from "./channel-webhooks";
import { MessageBody } from "./message-body";
import { PersonFace } from "./person";
import { call, channelTitle, MessagesError, messagesState, useMessages, useView } from "./store";

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();

function errorText(t: ReturnType<typeof useTranslations<"messages">>, error: unknown) {
  return t(`errors.${error instanceof MessagesError ? (error.code as "internal") : "internal"}`);
}

/** Picks people of the workspace by name or address; the chosen show as removable names above. */
export function PeoplePicker({ chosen, setChosen, leaveOut = [], max, focus = true }: { chosen: string[]; setChosen: (ids: string[]) => void; leaveOut?: string[]; max?: number; focus?: boolean }) {
  const t = useTranslations("messages");
  const view = useView();
  const [query, setQuery] = useState("");
  const found = useMemo(() => {
    const q = fold(query.trim());
    return [...view.people.values()]
      .filter((p) => !leaveOut.includes(p.id) && !chosen.includes(p.id) && (!q || fold(p.name).includes(q) || fold(p.email).includes(q)))
      .sort((a, b) => Number(a.agent) - Number(b.agent) || a.name.localeCompare(b.name))
      .slice(0, 30);
  }, [view.people, query, chosen, leaveOut]);
  const full = max !== undefined && chosen.length >= max;
  return (
    <div>
      {chosen.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chosen.map((id) => (
            <span key={id} className="flex h-7 items-center gap-1.5 rounded-md border border-border ps-1 pe-1.5 text-sm">
              <PersonFace s={view} userId={id} size="xs" presence={false} />
              {view.people.get(id)?.name ?? t("someone")}
              <button type="button" onClick={() => setChosen(chosen.filter((x) => x !== id))} aria-label={t("removePerson")} className="text-fg-muted hover:text-fg">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
        <Input autoFocus={focus} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("findPeople")} aria-label={t("findPeople")} className="ps-8" disabled={full} />
      </div>
      <div className="mt-2 max-h-64 overflow-y-auto">
        {found.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={full}
            onClick={() => {
              setChosen([...chosen, p.id]);
              setQuery("");
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start hover:bg-bg-hover disabled:opacity-50"
          >
            <PersonFace s={view} userId={p.id} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-fg">{p.name || p.email}</span>
              <span className="block truncate text-xs text-fg-faint">{p.agent ? t("agent") : p.email}</span>
            </span>
          </button>
        ))}
        {!found.length && <p className="px-2 py-3 text-sm text-fg-faint">{t("noPeopleFound")}</p>}
      </div>
      {full && <p className="mt-1 text-xs text-fg-muted">{t("directLimit", { count: MESSAGE_LIMITS.directPeople })}</p>}
    </div>
  );
}

function go(workspaceId: string, channelId: string) {
  window.history.pushState(null, "", messagesPath(workspaceId, { channelId }));
}

/** A new channel: its name (made into one as typed), whether it is private, what it is for and who joins. */
export function CreateChannelDialog({ workspaceId, open, close }: { workspaceId: string; open: boolean; close: () => void }) {
  const t = useTranslations("messages");
  const common = useTranslations("common");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priv, setPriv] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setPriv(false);
    setPeople([]);
    setError(null);
  }, [open]);
  const made = channelName(name);
  const problem = name ? channelNameError(made) : null;
  const me = useMessages((s) => s.me);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!made || problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = await call<string>("create", { name: made, kind: priv ? "private" : "public", description, memberIds: people });
      close();
      go(workspaceId, id);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={close}>
      <form onSubmit={submit}>
        <DialogHeader title={t("newChannel")} onClose={close} closeLabel={common("close")} />
        <DialogBody className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-fg">{t("channelName")}</span>
            <div className="relative">
              {priv ? <Lock className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" /> : <Hash className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />}
              <Input autoFocus value={name} maxLength={MESSAGE_LIMITS.name} onChange={(e) => setName(e.target.value)} placeholder={t("channelNamePlaceholder")} className="ps-8" />
            </div>
            {name && made !== name.trim() && !problem && <span className="mt-1 block text-xs text-fg-muted">{t("channelNameWillBe", { name: made })}</span>}
            {problem && <span className="mt-1 block text-xs text-danger">{t(`nameErrors.${problem}`)}</span>}
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-fg">
              {t("channelDescription")} <span className="font-normal text-fg-faint">{t("optional")}</span>
            </span>
            <textarea value={description} maxLength={MESSAGE_LIMITS.description} onChange={(e) => setDescription(e.target.value)} rows={2} className={textareaClass} />
          </label>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-fg">{t("makePrivate")}</p>
              <p className="text-xs text-fg-muted">{priv ? t("privateHint") : t("publicHint")}</p>
            </div>
            <Switch checked={priv} onChange={setPriv} label={t("makePrivate")} />
          </div>
          <div>
            <p className="mb-1 text-sm font-medium text-fg">
              {t("addPeople")} <span className="font-normal text-fg-faint">{t("optional")}</span>
            </p>
            <PeoplePicker chosen={people} setChosen={setPeople} leaveOut={[me]} focus={false} />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={close}>
            {common("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!made || !!problem || busy}>
            {t("create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** A direct conversation with one or more people (the same people always open the same one). */
export function NewDirectDialog({ workspaceId, open, close }: { workspaceId: string; open: boolean; close: () => void }) {
  const t = useTranslations("messages");
  const common = useTranslations("common");
  const me = useMessages((s) => s.me);
  const [people, setPeople] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setPeople([]);
  }, [open]);
  const start = async () => {
    if (!people.length || busy) return;
    setBusy(true);
    try {
      const id = await call<string>("direct", { userIds: people });
      close();
      go(workspaceId, id);
    } catch (err) {
      showToast({ message: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={close}>
      <DialogHeader title={t("newMessage")} onClose={close} closeLabel={common("close")} />
      <DialogBody>
        <PeoplePicker chosen={people} setChosen={setPeople} leaveOut={[me]} max={MESSAGE_LIMITS.directPeople - 1} />
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={close}>
          {common("cancel")}
        </Button>
        <Button variant="primary" disabled={!people.length || busy} onClick={start}>
          {t("startConversation")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** People added to a channel. */
export function AddPeopleDialog({ channelId, open, close }: { channelId: string; open: boolean; close: () => void }) {
  const t = useTranslations("messages");
  const common = useTranslations("common");
  const [people, setPeople] = useState<string[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPeople([]);
    void call<{ userId: string }[]>("members", { channelId }).then((list) => setMembers(list.map((m) => m.userId)), () => {});
  }, [open, channelId]);
  const add = async () => {
    setBusy(true);
    try {
      await call("add", { channelId, userIds: people });
      close();
    } catch (err) {
      showToast({ message: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={close}>
      <DialogHeader title={t("addPeople")} onClose={close} closeLabel={common("close")} />
      <DialogBody>
        <PeoplePicker chosen={people} setChosen={setPeople} leaveOut={members} />
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={close}>
          {common("cancel")}
        </Button>
        <Button variant="primary" disabled={!people.length || busy} onClick={add}>
          {t("add")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Forwards a message into a channel or conversation the person writes in, with words of their own. */
export function ForwardDialog({ workspaceId, messageId, close }: { workspaceId: string; messageId: string | null; close: () => void }) {
  const t = useTranslations("messages");
  const common = useTranslations("common");
  const view = useView();
  const memberships = useMessages((s) => s.memberships);
  const message = useMessages((s) => (messageId ? s.messages.get(messageId) : undefined));
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setQuery("");
    setTarget(null);
    setBody("");
  }, [messageId]);
  const words = { you: t("you"), someone: t("someone") };
  const places = useMemo(() => {
    const q = fold(query.trim());
    return [...memberships.values()]
      .flatMap((m) => {
        const c = view.channels.get(m.channelId);
        return c && !c.archivedAt ? [{ c, title: channelTitle(view, c, words) }] : [];
      })
      .filter((x) => !q || fold(x.title).includes(q))
      .sort((a, b) => (b.c.lastMessageAt ?? "").localeCompare(a.c.lastMessageAt ?? ""))
      .slice(0, 30);
  }, [memberships, view, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    if (!target || !messageId || busy) return;
    setBusy(true);
    try {
      await call("forward", { id: crypto.randomUUID(), messageId, channelId: target, body });
      close();
      showToast({ message: t("forwarded"), link: { href: messagesPath(workspaceId, { channelId: target }), label: t("open") } });
    } catch (err) {
      showToast({ message: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!messageId} onClose={close}>
      <DialogHeader title={t("forwardMessage")} onClose={close} closeLabel={common("close")} />
      <DialogBody className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("forwardTo")} aria-label={t("forwardTo")} className="ps-8" />
        </div>
        <div className="max-h-48 overflow-y-auto" role="listbox" aria-label={t("forwardTo")}>
          {places.map(({ c, title }) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={target === c.id}
              onClick={() => setTarget(c.id)}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm", target === c.id ? "bg-bg-active text-fg" : "hover:bg-bg-hover")}
            >
              <ChannelGlyph c={c} />
              <span className="truncate">{title}</span>
            </button>
          ))}
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder={t("forwardNote")} className={textareaClass} />
        {message && (
          <div className="rounded-md border-s-2 border-border bg-bg-subtle px-3 py-2">
            <p className="mb-1 text-xs text-fg-muted">{view.people.get(message.authorId ?? "")?.name ?? t("someone")}</p>
            <div className="line-clamp-4">
              <MessageBody body={message.body} workspaceId={workspaceId} />
            </div>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={close}>
          {common("cancel")}
        </Button>
        <Button variant="primary" disabled={!target || busy} onClick={send}>
          {t("forward")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ChannelGlyph({ c }: { c: ChannelView }) {
  const view = useView();
  if (c.kind === "direct") {
    const others = c.people.filter((id) => id !== view.me);
    return <PersonFace s={view} userId={others[0] ?? view.me} size="xs" count={others.length > 1 ? others.length : undefined} />;
  }
  return c.kind === "private" ? <Lock className="h-4 w-4 shrink-0 text-fg-icon" /> : <Hash className="h-4 w-4 shrink-0 text-fg-icon" />;
}

export type DetailsTab = "about" | "people";

type Member = { userId: string; role: "admin" | "member"; joinedAt: string };

/**
 * A channel's details beside it: what it is (name, topic, description: its admins change them, its
 * members the topic), its people (admins add, remove and name admins), the person's own
 * notifications, and the channel's settings and archiving for its admins. No tabs: sections down
 * one column, opened at the part asked for.
 */
export function ChannelDetails({
  workspaceId,
  channelId,
  tab,
  close,
  owner,
}: {
  workspaceId: string;
  channelId: string;
  tab: DetailsTab;
  setTab: (tab: DetailsTab) => void;
  close: () => void;
  owner: boolean;
}) {
  const t = useTranslations("messages");
  const view = useView();
  const channel = useMessages((s) => s.channels.get(channelId));
  const member = useMessages((s) => s.memberships.get(channelId));
  const rosterVersion = useMessages((s) => s.rosterVersion.get(channelId) ?? 0);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<"name" | "topic" | "description" | null>(null);
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    void call<Member[]>("members", { channelId }).then(setMembers, () => setMembers([]));
  }, [channelId, rosterVersion]);
  useEffect(() => {
    if (tab === "people") document.getElementById("channel-people")?.scrollIntoView({ block: "start" });
  }, [tab, members]);

  if (!channel) return null;
  const admin = owner || member?.role === "admin";
  const direct = channel.kind === "direct";
  const fail = (err: unknown) => showToast({ message: errorText(t, err) });
  const update = (patch: Record<string, unknown>) => call("update", { channelId, ...patch }).catch(fail);
  const prefs = (patch: Record<string, unknown>) => call("prefs", { channelId, ...patch }).catch(fail);
  const startEdit = (field: "name" | "topic" | "description") => {
    setEditing(field);
    setValue(field === "name" ? (channel.name ?? "") : channel[field]);
  };
  const saveEdit = async () => {
    if (!editing) return;
    const next = editing === "name" ? channelName(value) : value.trim();
    if (editing === "name") {
      const problem = channelNameError(next);
      if (problem) return showToast({ message: t(`nameErrors.${problem}`) });
    }
    await update({ [editing]: next });
    setEditing(null);
  };

  const field = (key: "name" | "topic" | "description", label: string, may: boolean, max: number) => (
    <div className="py-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-fg-muted">{label}</p>
        {may && editing !== key && (
          <button type="button" onClick={() => startEdit(key)} className="text-xs text-accent hover:underline">
            {t("edit")}
          </button>
        )}
      </div>
      {editing === key ? (
        <div className="mt-1">
          {key === "description" ? (
            <textarea autoFocus onFocus={(e) => e.currentTarget.select()} value={value} maxLength={max} onChange={(e) => setValue(e.target.value)} rows={3} className={textareaClass} />
          ) : (
            <Input
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              value={value}
              maxLength={max}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveEdit();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(null);
                }
              }}
            />
          )}
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
              {t("cancel")}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void saveEdit()}>
              {t("save")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-0.5 text-sm text-fg">
          {key === "name" ? (
            <span>#{channel.name}</span>
          ) : channel[key] ? (
            <MessageBody body={channel[key]} workspaceId={workspaceId} />
          ) : (
            <span className="text-fg-faint">{key === "topic" ? t("noTopic") : t("noDescription")}</span>
          )}
        </div>
      )}
    </div>
  );

  const shownMembers = (members ?? []).filter((m) => {
    const q = fold(query.trim());
    const p = view.people.get(m.userId);
    return !q || fold(p?.name ?? "").includes(q) || fold(p?.email ?? "").includes(q);
  });
  const notify = member?.notify ?? "default";

  return (
    <aside aria-label={t("channelDetails")} className="flex h-full min-h-0 w-full flex-col border-border bg-bg md:w-[24rem] md:shrink-0 md:border-s">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{direct ? t("conversationDetails") : t("channelDetails")}</h2>
        <button type="button" onClick={close} aria-label={t("closeDetails")} title={t("closeDetails")} className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {!direct && (
          <section className="border-b border-border py-2">
            {field("name", t("channelName"), admin && !channel.archivedAt, MESSAGE_LIMITS.name)}
            {field("topic", t("topic"), !!member && !channel.archivedAt, MESSAGE_LIMITS.topic)}
            {field("description", t("channelDescription"), admin && !channel.archivedAt, MESSAGE_LIMITS.description)}
            <p className="py-2 text-xs text-fg-faint">
              {t("createdBy", {
                person: channel.createdBy ? (view.people.get(channel.createdBy)?.name ?? t("someone")) : t("someone"),
                when: new Date(channel.createdAt).toLocaleDateString(),
              })}
            </p>
          </section>
        )}

        <section id="channel-people" className="border-b border-border py-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium text-fg-muted">{t("peopleCount", { count: members?.length ?? channel.memberCount })}</h3>
            {!direct && member && !channel.archivedAt && (channel.kind === "public" || admin) && (
              <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 text-xs text-accent hover:underline">
                <UserPlus className="h-3.5 w-3.5" />
                {t("addPeople")}
              </button>
            )}
          </div>
          {(members?.length ?? 0) > 8 && <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("findPeople")} aria-label={t("findPeople")} className="mb-2" />}
          {members === null ? (
            <p className="text-sm text-fg-faint">{t("loading")}</p>
          ) : (
            shownMembers.map((m) => (
              <div key={m.userId} className="group flex items-center gap-2.5 rounded-md px-1 py-1">
                <PersonFace s={view} userId={m.userId} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">
                    {view.people.get(m.userId)?.name ?? t("someone")}
                    {m.userId === view.me && <span className="text-fg-faint"> ({t("you")})</span>}
                  </span>
                  {m.role === "admin" && !direct && <span className="block text-xs text-fg-faint">{t("channelAdmin")}</span>}
                </span>
                {admin && !direct && m.userId !== view.me && !channel.archivedAt && (
                  <span className="flex gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => void call("role", { channelId, userId: m.userId, role: m.role === "admin" ? "member" : "admin" }).catch(fail)}
                      title={m.role === "admin" ? t("removeAdmin") : t("makeAdmin")}
                      aria-label={m.role === "admin" ? t("removeAdmin") : t("makeAdmin")}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
                    >
                      <Shield className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void call("remove", { channelId, userId: m.userId }).catch(fail)}
                      title={t("removeFromChannel")}
                      aria-label={t("removeFromChannel")}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-danger"
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                    </button>
                  </span>
                )}
              </div>
            ))
          )}
        </section>

        {member && (
          <section className="border-b border-border py-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-fg-muted">
              <Bell className="h-3.5 w-3.5" />
              {t("notifications")}
            </h3>
            <select
              value={notify}
              onChange={(e) => void prefs({ notify: e.target.value as ChannelNotify })}
              aria-label={t("notifications")}
              className={cn(selectClass, "w-full")}
            >
              <option value="default">{direct ? t("notifyDefaultDirect") : t("notifyDefaultChannel")}</option>
              <option value="all">{t("notifyAll")}</option>
              <option value="mentions">{t("notifyMentions")}</option>
              <option value="none">{t("notifyNone")}</option>
            </select>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-sm text-fg">{t("mute")}</span>
              <Switch checked={member.muted} onChange={(on) => void prefs({ muted: on })} label={t("mute")} />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-sm text-fg">{t("hideFromList")}</span>
              <Switch checked={member.hidden} onChange={(on) => void prefs({ hidden: on })} label={t("hideFromList")} />
            </div>
          </section>
        )}

        {!direct && admin && !channel.archivedAt && (
          <section className="border-b border-border py-3">
            <h3 className="mb-2 text-xs font-medium text-fg-muted">{t("channelSettings")}</h3>
            <div className="flex items-center justify-between gap-3 py-1">
              <span>
                <span className="block text-sm text-fg">{t("adminsPostOnly")}</span>
                <span className="block text-xs text-fg-muted">{t("adminsPostOnlyHint")}</span>
              </span>
              <Switch checked={channel.posting === "admins"} onChange={(on) => void update({ posting: on ? "admins" : "everyone" })} label={t("adminsPostOnly")} />
            </div>
            {channel.kind === "public" && (
              <div className="flex items-center justify-between gap-3 py-1">
                <span>
                  <span className="block text-sm text-fg">{t("joinNew")}</span>
                  <span className="block text-xs text-fg-muted">{t("joinNewHint")}</span>
                </span>
                <Switch checked={channel.joinNew} onChange={(on) => void update({ joinNew: on })} label={t("joinNew")} />
              </div>
            )}
            {channel.kind === "public" && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(t("makePrivateConfirm"))) void update({ private: true });
                }}
                className="mt-2 flex items-center gap-1.5 text-sm text-fg hover:underline"
              >
                <Lock className="h-4 w-4 text-fg-icon" />
                {t("convertPrivate")}
              </button>
            )}
          </section>
        )}

        {!direct && admin && !channel.archivedAt && <ChannelWebhooks channelId={channelId} />}

        <section className="space-y-1 py-3">
          {!direct && member && (
            <button
              type="button"
              onClick={() => {
                const last = channel.kind === "private" && (members?.length ?? 0) <= 1;
                if (!window.confirm(last ? t("leaveLastConfirm") : t("leaveConfirm", { name: channel.name ?? "" }))) return;
                void call("leave", { channelId }).then(() => {
                  close();
                  window.history.pushState(null, "", messagesPath(workspaceId));
                }, fail);
              }}
              className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-sm text-fg hover:bg-bg-hover"
            >
              <LogOut className="h-4 w-4 text-fg-icon" />
              {t("leaveChannel")}
            </button>
          )}
          {!direct && admin && (
            <button
              type="button"
              onClick={() => {
                if (!channel.archivedAt && !window.confirm(t("archiveConfirm", { name: channel.name ?? "" }))) return;
                void call("archive", { channelId, archived: !channel.archivedAt }).catch(fail);
              }}
              className={cn("flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-bg-hover", channel.archivedAt ? "text-fg" : "text-danger")}
            >
              <Archive className="h-4 w-4" />
              {channel.archivedAt ? t("unarchiveChannel") : t("archiveChannel")}
            </button>
          )}
        </section>
      </div>
      <AddPeopleDialog channelId={channelId} open={adding} close={() => setAdding(false)} />
    </aside>
  );
}

/** Public channels the person isn't in (and archived ones), to look into or join; owners may import channels from here (`importFrom`). */
export function BrowseChannels({ workspaceId, create, importFrom }: { workspaceId: string; create: () => void; importFrom?: () => void }) {
  const t = useTranslations("messages");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<ChannelView[] | null>(null);
  const memberships = useMessages((s) => s.memberships);
  useEffect(() => {
    const timer = setTimeout(() => void call<ChannelView[]>("browse", { query }).then(setList, () => setList([])), query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [query, memberships]);
  const join = (id: string) =>
    void call("join", { channelId: id }).then(
      () => go(workspaceId, id),
      (err) => showToast({ message: errorText(t, err) }),
    );
  return (
    <div className="mx-auto w-full max-w-[720px] px-4 py-6">
      <div className="mb-4 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchChannels")} aria-label={t("searchChannels")} className="ps-8" />
        </div>
        {importFrom && (
          <Button variant="secondary" onClick={importFrom}>
            {t("import.button")}
          </Button>
        )}
        <Button variant="primary" onClick={create}>
          {t("newChannel")}
        </Button>
      </div>
      {list === null ? (
        <p className="text-sm text-fg-faint">{t("loading")}</p>
      ) : list.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">{query ? t("noChannelsFound") : t("allJoined")}</p>
      ) : (
        <ul>
          {list.map((c) => (
            <li key={c.id} className="group flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-bg-hover">
              <a
                href={messagesPath(workspaceId, { channelId: c.id })}
                onClick={(e) => {
                  e.preventDefault();
                  go(workspaceId, c.id);
                }}
                className="min-w-0 flex-1"
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                  {c.kind === "private" ? <Lock className="h-3.5 w-3.5 text-fg-icon" /> : <Hash className="h-3.5 w-3.5 text-fg-icon" />}
                  {c.name}
                  {c.archivedAt && <span className="text-xs font-normal text-fg-faint">{t("archived")}</span>}
                </span>
                <span className="mt-0.5 block truncate text-xs text-fg-muted">
                  {t("peopleCount", { count: c.memberCount })}
                  {c.description ? ` · ${c.description}` : c.topic ? ` · ${c.topic}` : ""}
                </span>
              </a>
              {!c.archivedAt && !memberships.has(c.id) && (
                <Button size="sm" variant="secondary" onClick={() => join(c.id)} className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
                  {t("join")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const knownChannel = (id: string) => messagesState().channels.has(id);
