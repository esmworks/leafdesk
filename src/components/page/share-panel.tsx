"use client";

import { IconGlyph } from "@/components/builtin-icon";
import { Bot, Check, Clock, Link2, Mail, Search, Send, Users, UsersRound, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { UserAvatar } from "@/components/user-avatar";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { approveAccessRequestAction, declineAccessRequestAction, requestMoreAccessAction } from "@/app/actions/access-requests";
import {
  getSharingAction,
  removePageGroupPermissionAction,
  removePageInvitationAction,
  removePagePermissionAction,
  setPageGroupPermissionAction,
  setPagePermissionAction,
  sharePageByEmailAction,
  type SharingResult,
} from "@/app/actions/sharing";
import { Button, cn, Input, selectClass } from "@/components/ui";
import type { PageLevel } from "@/db/schema";
import { ACCESS_REQUEST_MESSAGE_MAX, initialApprovalLevel, isAbove, type ApprovalLevel, type MoreAccessLevel } from "@/lib/access-requests";
import { AGENT_ACCESS_LEVELS } from "@/lib/agents";
import { isEmail, normalizeEmail } from "@/lib/emails";
import { searchFold } from "@/lib/search-fold";
import { useLocalMode } from "@/components/local-mode";
import { PublishTab } from "./publish-tab";

type Sharing = Awaited<ReturnType<typeof getSharingAction>>;
type CurrentUser = { id: string; name: string; email?: string };

const LEVELS: PageLevel[] = ["full", "edit", "comment", "view", "none"];
const RANK: Record<PageLevel, number> = { none: 0, view: 1, comment: 2, edit: 3, full: 4 };

/**
 * The Share popover: who can open the page (Share) and the public web link (Publish). Templates
 * are never published, so they only get the Share tab.
 */
export function SharePanel({
  pageId,
  currentUser,
  publishable = true,
  onChange,
}: {
  pageId: string;
  currentUser: CurrentUser;
  publishable?: boolean;
  /** After a sharing change, e.g. so the header updates its count of access requests. */
  onChange?: () => void;
}) {
  const t = useTranslations("page.share");
  const [tab, setTab] = useState<"share" | "publish">("share");
  // Leafdesk on one computer has no public address to publish to.
  const localMode = useLocalMode();
  const withPublish = publishable && !localMode;
  return (
    <div className="w-full md:w-[min(28rem,calc(100vw-2rem))]">
      <div className="flex gap-4 border-b border-border px-3" role="tablist">
        {(withPublish ? (["share", "publish"] as const) : (["share"] as const)).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px border-b-2 py-2 text-sm",
              tab === key ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            {key === "share" ? t("tabShare") : t("tabPublish")}
          </button>
        ))}
      </div>
      {tab === "share" || !withPublish ? <ShareTab pageId={pageId} currentUser={currentUser} onChange={onChange} /> : <PublishTab pageId={pageId} />}
    </div>
  );
}

function ShareTab({ pageId, currentUser, onChange }: { pageId: string; currentUser: CurrentUser; onChange?: () => void }) {
  const currentUserId = currentUser.id;
  const t = useTranslations("page.share");
  const localMode = useLocalMode();
  const tc = useTranslations("common");
  const [data, setData] = useState<Sharing | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // After inviting someone without an account: whether the email went out, and the link otherwise.
  const [invited, setInvited] = useState<{ email: string; link: string; sent: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getSharingAction(pageId));
    } catch {
      setError(t("errors.generic"));
    }
  }, [pageId, t]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<SharingResult>) => {
    setBusy(true);
    setError(null);
    setInvited(null);
    try {
      const result = await action();
      if (!result.ok) setError(t(`errors.${result.code}`));
    } catch {
      // A thrown action (network, session) must not leave the panel greyed out.
      setError(t("errors.generic"));
    } finally {
      await load();
      setBusy(false);
      onChange?.();
    }
  };

  const canManage = data?.level === "full";
  // Those "everyone" reaches (the teamspace's members, or the workspace's for a private page) get
  // at least that much, so a lower entry of their own has no effect. Guests are never reached.
  const floorFor = (userId: string | null): PageLevel => (userId && data?.floors[userId]) || "none";
  const addLevel = (userId: string): PageLevel => {
    const floor = floorFor(userId);
    return RANK[floor] > RANK.edit ? floor : "edit";
  };
  const listed = useMemo(() => new Set(data?.entries.map((e) => e.userId)), [data]);
  const candidates = useMemo(() => {
    const q = searchFold(query.trim());
    if (!data || !q) return [];
    return data.members
      .filter((m) => !listed.has(m.userId) && m.userId !== currentUserId)
      .filter((m) => searchFold(m.name).includes(q) || searchFold(m.email).includes(q))
      .slice(0, 6);
  }, [data, query, listed, currentUserId]);
  // Groups are picked like people, by name; ones already on the page change from their row.
  const groupCandidates = useMemo(() => {
    const q = searchFold(query.trim());
    if (!data || !q) return [];
    const shared = new Set(data.groups.map((g) => g.groupId));
    return data.groupOptions
      .filter((g) => !shared.has(g.groupId) && searchFold(g.name).includes(q))
      .slice(0, 4);
  }, [data, query]);
  // Agents are picked by name too; ones already on the page change from their row.
  const agentCandidates = useMemo(() => {
    const q = searchFold(query.trim());
    if (!data || !q) return [];
    return data.agentOptions.filter((a) => !listed.has(a.userId) && searchFold(a.name).includes(q)).slice(0, 4);
  }, [data, query, listed]);

  const copyLink = (text = window.location.href.split("?")[0]) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // An address typed in full can be shared with even when it isn't a member: owners can bring
  // people in as guests. A member with that address already shows up as a candidate.
  const typedEmail = normalizeEmail(query);
  const invitable =
    isEmail(typedEmail) &&
    !data?.members.some((m) => m.email.toLocaleLowerCase() === typedEmail) &&
    !data?.invitations.some((i) => i.email === typedEmail);
  const shareByEmail = (email: string) => {
    setQuery("");
    void run(async () => {
      const result = await sharePageByEmailAction(pageId, email, "edit");
      if (result.ok && result.data?.kind === "invited") {
        const { link, delivery } = result.data;
        setInvited({ email, link, sent: delivery === "sent" });
      }
      return result;
    });
  };

  if (!data) {
    return <div className="px-3 py-6 text-sm text-fg-muted">{error ?? t("loading")}</div>;
  }

  const self = data.members.find((m) => m.userId === currentUserId);
  const mine = data.entries.find((e) => e.userId === currentUserId);
  const myName = self?.name || currentUser.name;
  const others = data.entries.filter((e) => e.userId !== currentUserId);
  const everyoneLabel = t(`levels.${data.everyone}`);
  const overridden = (userId: string | null, level: PageLevel) =>
    RANK[level] < RANK[floorFor(userId)] ? t("overridden", { level: everyoneLabel }) : undefined;

  // Restricting everyone needs someone with full access left; keep it yourself unless someone has it.
  const setEveryone = (level: PageLevel) =>
    void run(async () => {
      if (level !== "full" && !data.entries.some((e) => e.level === "full")) {
        const kept = await setPagePermissionAction(pageId, currentUserId, "full");
        if (!kept.ok) return kept;
      }
      return setPagePermissionAction(pageId, null, level);
    });

  return (
    <div className={cn("p-3", busy && "pointer-events-none opacity-70")}>
      {canManage && data.requests.length > 0 && (
        <div className="mb-3 border-b border-border pb-3">
          <p className="mb-1 text-xs font-medium text-fg-muted">{t("requests.heading")}</p>
          <ul className="space-y-2">
            {data.requests.map((request) => (
              <AccessRequestRow
                key={request.id}
                request={request}
                initialLevel={initialApprovalLevel(request, request.inWorkspace ? (addLevel(request.requesterId) as ApprovalLevel) : "edit")}
                onApprove={(level) => void run(() => approveAccessRequestAction(request.id, level))}
                onDecline={() => void run(() => declineAccessRequestAction(request.id))}
              />
            ))}
          </ul>
        </div>
      )}
      {canManage ? (
        <div className="relative">
          <label className="flex h-9 items-center gap-2 rounded-md border border-border px-2 focus-within:border-accent">
            <Search className="h-4 w-4 shrink-0 text-fg-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={data.agentOptions.length ? t("addPeopleOrAgents") : t("addPeople")}
              aria-label={data.agentOptions.length ? t("addPeopleOrAgents") : t("addPeople")}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
            />
          </label>
          {query.trim() && (
            <div className="absolute inset-x-0 top-full z-10 mt-1 rounded-lg border border-border bg-bg p-1 shadow-lg">
              {candidates.map((m) => (
                <button
                  key={m.userId}
                  type="button"
                  onClick={() => {
                    setQuery("");
                    void run(() => setPagePermissionAction(pageId, m.userId, addLevel(m.userId)));
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start hover:bg-bg-hover"
                >
                  <Avatar name={m.name} image={m.image} />
                  <PersonLabel name={m.name} detail={m.email} />
                </button>
              ))}
              {groupCandidates.map((g) => (
                <button
                  key={g.groupId}
                  type="button"
                  onClick={() => {
                    setQuery("");
                    void run(() => setPageGroupPermissionAction(pageId, g.groupId, "edit"));
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start hover:bg-bg-hover"
                >
                  <GroupAvatar />
                  <PersonLabel name={g.name} detail={t("groupMembers", { count: g.memberCount })} />
                </button>
              ))}
              {agentCandidates.map((a) => (
                <button
                  key={a.userId}
                  type="button"
                  onClick={() => {
                    setQuery("");
                    // As in the agent's settings, an agent starts by viewing; its row raises it.
                    void run(() => setPagePermissionAction(pageId, a.userId, "view"));
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start hover:bg-bg-hover"
                >
                  <AgentAvatar icon={a.icon} />
                  <PersonLabel name={a.name} detail={a.enabled ? tc("agent") : t("agentPaused")} />
                </button>
              ))}
              {invitable && data.canInvite && (
                <button
                  type="button"
                  onClick={() => shareByEmail(typedEmail)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start hover:bg-bg-hover"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-hover text-fg-muted">
                    <Send className="h-3.5 w-3.5" />
                  </span>
                  <PersonLabel name={t("shareWith", { email: typedEmail })} detail={t("asGuest")} />
                </button>
              )}
              {!candidates.length && !groupCandidates.length && !agentCandidates.length && !(invitable && data.canInvite) && (
                <p className="px-2 py-1.5 text-sm text-fg-muted">{data.agentOptions.length ? t("noMatchesWithAgents") : t("noMatches")}</p>
              )}
              {/* On one computer there is no one outside the workspace to share with. */}
              {!localMode && (
                <p className="border-t border-border px-2 pt-1.5 pb-1 text-xs text-fg-faint">
                  {data.canInvite ? t("guestHint") : t("membersOnly")}
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          <p className="text-xs text-fg-muted">{t("readOnly")}</p>
          {(data.askable.length > 0 || data.myRequest) && (
            <AskForMore pageId={pageId} current={data.level} askable={data.askable} pending={data.myRequest} onSent={() => void load()} />
          )}
        </>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
      {invited && (
        <div role="status" className="mt-2 flex items-center gap-2 rounded-md bg-bg-hover px-2 py-1.5 text-xs text-fg-muted">
          <span className="min-w-0 flex-1">
            {invited.sent ? t("invitedSent", { email: invited.email }) : t("invitedNoEmail", { email: invited.email })}
          </span>
          {!invited.sent && (
            <button
              type="button"
              onClick={() => copyLink(invited.link)}
              className="shrink-0 rounded-md border border-border px-2 py-0.5 text-fg hover:bg-bg"
            >
              {copied ? t("copied") : t("copyInvite")}
            </button>
          )}
        </div>
      )}

      <ul className="mt-3 space-y-0.5">
        <Row
          avatar={<Avatar name={myName} image={self?.image ?? mine?.image} />}
          label={
            <PersonLabel
              name={`${myName} (${t("you")})`}
              detail={(mine && overridden(currentUserId, mine.level)) ?? self?.email ?? currentUser.email}
            />
          }
          control={
            // Your own entry is how you keep full access while making the page private. Without one,
            // the select shows the level you get from elsewhere, so picking it still adds the entry.
            canManage ? (
              <LevelSelect
                value={mine?.level ?? null}
                placeholder={
                  // Where the teamspace decides, its owners and the workspace's owners get more than everyone.
                  data.everyoneFromTeamspace && RANK[floorFor(currentUserId)] > RANK[data.everyone]
                    ? t("viaOwner", { level: t(`levels.${data.level}`) })
                    : t("viaGeneral", { level: t(`levels.${data.level}`) })
                }
                floor={floorFor(currentUserId)}
                onChange={(level) => void run(() => setPagePermissionAction(pageId, currentUserId, level))}
                onRemove={
                  mine && !mine.inherited
                    ? () => void run(() => removePagePermissionAction(pageId, currentUserId))
                    : undefined
                }
              />
            ) : (
              <LevelText level={data.level} />
            )
          }
        />
        {others.map((entry) => (
          <Row
            key={entry.userId}
            avatar={entry.isAgent ? <AgentAvatar icon={entry.agentIcon} /> : <Avatar name={entry.name ?? "?"} image={entry.image} />}
            label={
              <PersonLabel
                name={entry.name ?? entry.email ?? "?"}
                detail={
                  overridden(entry.userId, entry.level) ??
                  (entry.inherited
                    ? // A page above it that they can't open isn't named.
                      entry.sourceTitle === null
                      ? t("inheritedAbove")
                      : t("inherited", { title: entry.sourceTitle || "…" })
                    : entry.isAgent
                      ? tc("agent")
                      : (entry.email ?? undefined))
                }
              />
            }
            control={
              canManage ? (
                <LevelSelect
                  value={entry.level}
                  // An agent views, comments or edits; it never gets full access.
                  only={entry.isAgent ? AGENT_ACCESS_LEVELS : undefined}
                  floor={floorFor(entry.userId)}
                  onChange={(level) => void run(() => setPagePermissionAction(pageId, entry.userId, level))}
                  onRemove={
                    entry.inherited ? undefined : () => void run(() => removePagePermissionAction(pageId, entry.userId))
                  }
                />
              ) : (
                <LevelText level={entry.level} />
              )
            }
          />
        ))}
        {data.groups.map((entry) => (
          <Row
            key={entry.groupId}
            avatar={<GroupAvatar />}
            label={
              <PersonLabel
                // Guests learn that a group has access, not which one or how big it is.
                name={entry.name ?? t("hiddenGroup")}
                detail={
                  entry.inherited
                    ? entry.sourceTitle === null
                      ? t("groupInheritedAbove")
                      : t("groupInherited", { title: entry.sourceTitle || "…" })
                    : entry.memberCount === null
                      ? t("group")
                      : t("groupMembers", { count: entry.memberCount })
                }
              />
            }
            control={
              canManage ? (
                <LevelSelect
                  value={entry.level}
                  onChange={(level) => void run(() => setPageGroupPermissionAction(pageId, entry.groupId, level))}
                  onRemove={
                    entry.inherited ? undefined : () => void run(() => removePageGroupPermissionAction(pageId, entry.groupId))
                  }
                />
              ) : (
                <LevelText level={entry.level} />
              )
            }
          />
        ))}
        {data.invitations.map((invitation) => (
          <Row
            key={invitation.email}
            avatar={
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-hover text-fg-muted">
                <Mail className="h-3.5 w-3.5" />
              </span>
            }
            label={<PersonLabel name={invitation.email} detail={t("pending")} />}
            control={
              <div className="flex items-center gap-0.5">
                <LevelText level={invitation.level} />
                <button
                  type="button"
                  aria-label={t("cancelInvite")}
                  title={t("cancelInvite")}
                  onClick={() => void run(() => removePageInvitationAction(pageId, invitation.email))}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-danger"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            }
          />
        ))}
      </ul>

      <div className="mt-3 border-t border-border pt-3">
        <p className="mb-1 text-xs font-medium text-fg-muted">{t("generalAccess")}</p>
        <Row
          avatar={
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-bg-hover text-fg-muted">
              <Users className="h-4 w-4" />
            </span>
          }
          label={
            <PersonLabel
              name={
                data.space.kind === "private"
                  ? t("everyone")
                  : data.space.name
                    ? t("everyoneIn", { name: data.space.name })
                    : t("everyoneTeamspace")
              }
            />
          }
          control={
            canManage ? (
              <LevelSelect
                value={data.everyone}
                onChange={setEveryone}
              />
            ) : (
              <LevelText level={data.everyone} />
            )
          }
        />
        <p className="mt-1 text-xs text-fg-faint">
          {data.space.kind === "private" ? t("everyoneHint") : t("everyoneTeamspaceHint")}
          {data.everyoneFromTeamspace && <> {t("everyoneFromTeamspaceHint")}</>}
        </p>
      </div>

      <div className="mt-3 flex justify-end border-t border-border pt-3">
        <button
          type="button"
          onClick={() => copyLink()}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:bg-bg-hover"
        >
          {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Link2 className="h-4 w-4" />}
          {copied ? t("copied") : t("copyLink")}
        </button>
      </div>
    </div>
  );
}

/** A pending request for access: who asked (and what they wrote), the level to share at, Share and Decline. */
function AccessRequestRow({
  request,
  initialLevel,
  onApprove,
  onDecline,
}: {
  request: Sharing["requests"][number];
  initialLevel: PageLevel;
  onApprove: (level: PageLevel) => void;
  onDecline: () => void;
}) {
  const t = useTranslations("page.share");
  const [level, setLevel] = useState<PageLevel>(initialLevel === "none" ? "edit" : initialLevel);
  const note = !request.inWorkspace ? (request.approvable ? t("requests.outsider") : t("requests.cantInvite")) : null;
  // Someone who can open the page is shared more, never less, than they have.
  const choices = LEVELS.filter((l) => l !== "none" && isAbove(l, request.current));
  return (
    <li className="list-none">
      <div className="flex items-center gap-2">
        <Avatar name={request.name || request.email || "?"} image={request.image} />
        <div className="min-w-0 flex-1">
          <PersonLabel name={request.name || request.email || "?"} detail={request.email ?? undefined} />
        </div>
      </div>
      {request.level !== "view" && (
        <p className="mt-1 ms-9 text-xs text-fg-muted">
          {t("requests.asksMore", { level: t(`levels.${request.level}`), current: t(`levels.${request.current}`) })}
        </p>
      )}
      {request.message && (
        <p className="mt-1 ms-9 text-sm break-words whitespace-pre-line text-fg-muted">{t("requests.message", { message: request.message })}</p>
      )}
      {note && <p className="mt-1 ms-9 text-xs text-fg-faint">{note}</p>}
      <div className="mt-1.5 ms-9 flex flex-wrap items-center gap-1.5">
        <select
          value={level}
          aria-label={t("requests.level")}
          onChange={(e) => setLevel(e.target.value as PageLevel)}
          disabled={!request.approvable}
          className="h-7 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none"
        >
          {choices.map((l) => (
            <option key={l} value={l}>
              {t(`levels.${l}`)}
            </option>
          ))}
        </select>
        <Button size="sm" variant="primary" disabled={!request.approvable} onClick={() => onApprove(level)}>
          {t("requests.approve")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDecline}>
          {t("requests.decline")}
        </Button>
      </div>
    </li>
  );
}

/**
 * For someone who can view or comment on the page: ask the people with full access for more
 * (server/access-requests.ts `requestMoreAccess`), with an optional message. Once asked, what they
 * asked for shows until it is answered.
 */
function AskForMore({
  pageId,
  current,
  askable,
  pending,
  onSent,
}: {
  pageId: string;
  current: PageLevel;
  askable: MoreAccessLevel[];
  pending: PageLevel | null;
  onSent: () => void;
}) {
  const t = useTranslations("page.share.askMore");
  const tl = useTranslations("page.share.levels");
  const tc = useTranslations("common");
  const [level, setLevel] = useState<MoreAccessLevel>(askable.includes("edit") ? "edit" : (askable[0] ?? "edit"));
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "rateLimited" | "unavailable" | "error">("idle");

  if (pending) {
    return (
      <p role="status" className="mt-2 flex items-start gap-2 rounded-md bg-bg-hover px-2.5 py-2 text-xs text-fg-muted">
        <Clock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t("pending", { level: tl(pending) })}</span>
      </p>
    );
  }

  const send = async () => {
    setState("sending");
    try {
      const outcome = await requestMoreAccessAction(pageId, level, message);
      if (outcome === "sent") {
        setMessage("");
        setState("idle");
        onSent();
      } else setState(outcome === "rateLimited" ? "rateLimited" : outcome === "unavailable" ? "unavailable" : "error");
    } catch {
      setState("error");
    }
  };

  return (
    <form
      className="mt-3 space-y-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div>
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-xs text-fg-muted">{t("description", { level: tl(current) })}</p>
      </div>
      <div className="flex gap-1.5">
        <select
          value={level}
          aria-label={t("level")}
          onChange={(e) => setLevel(e.target.value as MoreAccessLevel)}
          className={cn(selectClass, "shrink-0")}
        >
          {[...askable].reverse().map((l) => (
            <option key={l} value={l}>
              {tl(l)}
            </option>
          ))}
        </select>
        <Input
          value={message}
          maxLength={ACCESS_REQUEST_MESSAGE_MAX}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t("messagePlaceholder")}
          aria-label={t("messagePlaceholder")}
          className="h-8 min-w-0 flex-1"
        />
        <Button type="submit" size="sm" variant="primary" className="h-8 shrink-0" disabled={state === "sending"}>
          {state === "sending" ? t("sending") : t("send")}
        </Button>
      </div>
      {(state === "rateLimited" || state === "unavailable" || state === "error") && (
        <p role="alert" className="text-xs text-danger">
          {state === "error" ? tc("genericError") : t(state)}
        </p>
      )}
    </form>
  );
}

function Row({ avatar, label, control }: { avatar: ReactNode; label: ReactNode; control: ReactNode }) {
  return (
    <li className="flex list-none items-center gap-2 py-1">
      {avatar}
      <div className="min-w-0 flex-1">{label}</div>
      <div className="shrink-0">{control}</div>
    </li>
  );
}

function PersonLabel({ name, detail }: { name: string; detail?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm">{name}</div>
      {detail && (
        <div className="truncate text-xs text-fg-muted" title={detail}>
          {detail}
        </div>
      )}
    </div>
  );
}

function Avatar({ name, image }: { name: string; image?: string | null }) {
  return <UserAvatar name={name} image={image} size="md" colors="bg-accent/15 text-accent" />;
}

/** An agent's icon, or a robot when it has none. */
function AgentAvatar({ icon }: { icon: string | null }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-active text-sm text-fg-muted" aria-hidden>
      {icon ? <IconGlyph icon={icon} /> : <Bot className="h-3.5 w-3.5" />}
    </span>
  );
}

function GroupAvatar() {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
      <UsersRound className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

function LevelText({ level }: { level: PageLevel }) {
  const t = useTranslations("page.share.levels");
  return <span className="px-2 text-sm text-fg-muted">{t(level)}</span>;
}

/**
 * `floor`: levels below it have no effect for this person, so they can't be picked. `only`: the
 * levels offered (the current one is shown either way).
 */
function LevelSelect({
  value,
  placeholder,
  floor = "none",
  only,
  onChange,
  onRemove,
}: {
  value: PageLevel | null;
  placeholder?: string;
  floor?: PageLevel;
  only?: readonly PageLevel[];
  onChange: (level: PageLevel) => void;
  onRemove?: () => void;
}) {
  const t = useTranslations("page.share");
  return (
    <div className="flex items-center gap-0.5">
      <select
        value={value ?? ""}
        onChange={(e) => e.target.value && onChange(e.target.value as PageLevel)}
        className="h-7 max-w-44 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none"
      >
        {value === null && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {LEVELS.filter((level) => !only || only.includes(level) || level === value).map((level) => (
          <option key={level} value={level} disabled={RANK[level] < RANK[floor] && level !== value}>
            {t(`levels.${level}`)}
          </option>
        ))}
      </select>
      {onRemove && (
        <button
          type="button"
          aria-label={t("remove")}
          title={t("remove")}
          onClick={onRemove}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-danger"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
