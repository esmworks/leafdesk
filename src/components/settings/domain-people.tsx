"use client";

/**
 * Settings > Security > People from your domains (owners, while the workspace has verified email
 * domains): the accounts on this server with an address in them, whether each is in the workspace
 * and as what, when they were last active and how they sign in. Those outside are added through the
 * same step as Settings > Members > Add, those inside removed as there.
 */
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { addMembersAction, removeMemberAction } from "@/app/actions/workspaces";
import { Button, cn, Input, selectClass } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import type { WorkspaceRole } from "@/db/schema";
import { ConfirmButton } from "./confirm-button";
import { deliveryText } from "./invitation-delivery";
import { useAction } from "./workspace-settings";

export type DomainPersonView = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  emailVerified: boolean;
  role: WorkspaceRole | null;
  lastActiveAt: string | null;
  signIn: string[];
};

type Filter = "all" | "in" | "out";

const KNOWN_METHODS = ["password", "sso", "passkey"] as const;

export function DomainPeople({
  workspaceId,
  currentUserId,
  domains,
  people,
  more,
  now,
}: {
  workspaceId: string;
  currentUserId: string;
  domains: string[];
  people: DomainPersonView[];
  more: boolean;
  /** The server's time, for "3 hours ago" (the same on the server and in the browser). */
  now: Date;
}) {
  const t = useTranslations("settings.domainPeople");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const inside = people.filter((p) => p.role !== null).length;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter(
      (p) =>
        (filter === "all" || (filter === "in") === (p.role !== null)) &&
        (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)),
    );
  }, [people, filter, query]);

  return (
    <div>
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
        <p className="min-w-0 flex-1 text-sm text-fg-muted">
          {t("summary", { count: people.length, inside, domains: domains.join(", ") })}
          {more && ` ${t("more")}`}
        </p>
        <Input className="sm:w-48" value={query} placeholder={t("search")} aria-label={t("search")} onChange={(e) => setQuery(e.target.value)} />
        <select className={cn(selectClass, "sm:w-48")} value={filter} aria-label={t("filter")} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">{t("filters.all")}</option>
          <option value="in">{t("filters.in")}</option>
          <option value="out">{t("filters.out")}</option>
        </select>
      </div>
      {shown.length === 0 ? (
        <p className="border-t border-border px-5 py-4 text-sm text-fg-muted">{people.length ? t("noMatches") : t("empty")}</p>
      ) : (
        <div className="relative overflow-x-auto border-t border-border">
          <table className="w-full min-w-[720px] table-fixed text-sm" data-domain-people>
            <thead className="border-b border-border bg-bg-subtle text-xs whitespace-nowrap text-fg-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-start font-normal">
                  {t("columns.person")}
                </th>
                <th scope="col" className="w-36 px-4 py-2.5 text-start font-normal">
                  {t("columns.workspace")}
                </th>
                <th scope="col" className="w-32 px-4 py-2.5 text-start font-normal">
                  {t("columns.lastActive")}
                </th>
                <th scope="col" className="w-28 px-4 py-2.5 text-start font-normal">
                  {t("columns.signIn")}
                </th>
                <th scope="col" className="w-36">
                  <span className="sr-only">{t("columns.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map((person) => (
                <PersonRow key={person.userId} workspaceId={workspaceId} person={person} self={person.userId === currentUserId} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PersonRow({ workspaceId, person, self, now }: { workspaceId: string; person: DomainPersonView; self: boolean; now: Date }) {
  const t = useTranslations("settings.domainPeople");
  const tm = useTranslations("settings.members");
  const tc = useTranslations("common");
  const tErrors = useTranslations("settings.errors");
  const format = useFormatter();
  const { pending, error, run } = useAction();
  const [note, setNote] = useState<string | null>(null);
  const name = person.name || person.email;
  const method = (m: string) =>
    (KNOWN_METHODS as readonly string[]).includes(m) ? t(`methods.${m as (typeof KNOWN_METHODS)[number]}`) : m.charAt(0).toUpperCase() + m.slice(1);

  return (
    <tr className="align-middle" data-domain-person={person.email}>
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <UserAvatar name={name} image={person.image} size="md" />
          <div className="min-w-0">
            <div className="truncate font-medium">
              {name}
              {self && <span className="font-normal text-fg-muted"> {tm("you")}</span>}
            </div>
            <div className="truncate text-xs text-fg-muted">{person.email}</div>
            {!person.emailVerified && <div className="truncate text-xs text-fg-muted">{t("unverified")}</div>}
          </div>
        </div>
        {(error || note) && <p className={cn("mt-1 text-xs", error ? "text-danger" : "text-fg-muted")}>{error ?? note}</p>}
      </td>
      <td className={cn("px-4 py-3 whitespace-nowrap", !person.role && "text-fg-muted")}>{person.role ? tm(`roles.${person.role}`) : t("outside")}</td>
      <td className="px-4 py-3 whitespace-nowrap text-fg-muted">
        {person.lastActiveAt ? format.relativeTime(new Date(person.lastActiveAt), now) : t("never")}
      </td>
      <td className="truncate px-4 py-3 text-fg-muted">{person.signIn.length ? person.signIn.map(method).join(", ") : t("noSignIn")}</td>
      <td className="px-4 py-3 text-end whitespace-nowrap">
        {person.role === null ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              run(
                () => addMembersAction(workspaceId, [person.email], "member"),
                (results) => {
                  const r = results[0];
                  setNote(
                    !r
                      ? tc("genericError")
                      : r.kind === "added"
                        ? tm("add.added")
                        : r.kind === "invited"
                          ? tm(deliveryText(r.delivery))
                          : r.kind === "requested"
                            ? tm("add.requested")
                            : tErrors(r.code),
                  );
                },
              )
            }
          >
            {t("add")}
          </Button>
        ) : self ? null : (
          <ConfirmButton
            label={t("remove")}
            note={tm("removeBody", { name })}
            working={t("removing")}
            failed={tc("genericError")}
            act={async () => {
              const result = await removeMemberAction(workspaceId, person.userId);
              return result.ok ? null : result.error;
            }}
          />
        )}
      </td>
    </tr>
  );
}
