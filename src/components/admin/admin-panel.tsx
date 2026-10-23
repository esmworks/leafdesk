"use client";

import { MoreHorizontal } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import {
  clearWorkspaceNetworksAction,
  requirePasswordResetAction,
  requirePasswordResetForEveryoneAction,
  signOutEveryoneAction,
  signOutUserAction,
} from "@/app/actions/admin";
import type { ActionResult } from "@/app/actions/workspaces";
import { Floating, useFloating } from "@/components/database/floating";
import { SettingsRow } from "@/components/settings/section";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, Dialog, IconButton, MenuItem } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import type { InstanceUser, NetworkRestrictedWorkspace } from "@/server/instance-admin";

type Confirmation = { title: string; body: string; confirm: string; action: () => Promise<ActionResult<unknown>> };

/** Asks before an admin action; its failure shows in the dialog, success closes it. */
function ConfirmDialog({ confirmation, onClose }: { confirmation: Confirmation; onClose: () => void }) {
  const tc = useTranslations("common");
  const { pending, error, run } = useAction();
  return (
    <Dialog open onClose={onClose} className="max-w-md text-start">
      <div className="space-y-3 p-5">
        <h2 className="text-base font-semibold">{confirmation.title}</h2>
        <p className="text-sm text-fg-muted">{confirmation.body}</p>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() => run(confirmation.action, onClose)}
          >
            {confirmation.confirm}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Server-wide: sign everyone out, or make everyone with a password choose a new one. */
export function AdminSessionControls({ emailReset }: { emailReset: boolean }) {
  const t = useTranslations("admin.sessions");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  return (
    <>
      <SettingsRow
        title={t("signOutEveryone")}
        description={t("signOutEveryoneDescription")}
        control={
          <Button
            size="sm"
            onClick={() =>
              setConfirmation({
                title: t("signOutEveryoneTitle"),
                body: t("signOutEveryoneBody"),
                confirm: t("signOutEveryoneConfirm"),
                action: signOutEveryoneAction,
              })
            }
          >
            {t("signOutEveryone")}
          </Button>
        }
      />
      <SettingsRow
        title={t("resetEveryone")}
        description={`${t("resetEveryoneDescription")} ${emailReset ? t("resetByEmail") : t("resetInApp")}`}
        control={
          <Button
            size="sm"
            onClick={() =>
              setConfirmation({
                title: t("resetEveryoneTitle"),
                body: t("resetEveryoneBody"),
                confirm: t("resetEveryoneConfirm"),
                action: requirePasswordResetForEveryoneAction,
              })
            }
          >
            {t("resetEveryone")}
          </Button>
        }
      />
      {confirmation && <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />}
    </>
  );
}

/**
 * The workspaces that only open from approved networks, each with a button that clears its list:
 * the way back in when a list shuts its owners out.
 */
export function AdminNetworkControls({ workspaces }: { workspaces: NetworkRestrictedWorkspace[] }) {
  const t = useTranslations("admin.networks");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  if (!workspaces.length) return <SettingsRow title={t("none")} description={t("noneDescription")} />;
  return (
    <>
      {workspaces.map((w) => (
        <SettingsRow
          key={w.id}
          title={w.name}
          description={
            <>
              {t("count", { count: w.networks.length })}:{" "}
              <span className="break-all">{w.networks.map((n) => n.range).join(", ")}</span>
            </>
          }
          control={
            <Button
              size="sm"
              onClick={() =>
                setConfirmation({
                  title: t("clearTitle", { workspace: w.name }),
                  body: t("clearBody"),
                  confirm: t("clearConfirm"),
                  action: () => clearWorkspaceNetworksAction(w.id),
                })
              }
            >
              {t("clear")}
            </Button>
          }
        />
      ))}
      {confirmation && <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />}
    </>
  );
}

export function AdminUsersTable({
  users,
  currentUserId,
  emailReset,
  now,
  query,
}: {
  users: InstanceUser[];
  currentUserId: string;
  /** Whether a required reset goes out by email (SMTP) or happens right after sign-in. */
  emailReset: boolean;
  /** Render time from the server, so relative dates match between server and client render. */
  now: Date;
  query: string;
}) {
  const t = useTranslations("admin.users");
  if (!users.length) {
    return (
      <div className="rounded-xl border border-border px-4 py-8 text-center text-sm text-fg-muted">
        {query ? t("noMatches") : t("none")}
      </div>
    );
  }
  return (
    <div className="relative overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="border-b border-border bg-bg-subtle text-xs text-fg-muted">
          <tr>
            <th scope="col" className="px-4 py-2.5 text-start font-normal">
              {t("columns.user")}
            </th>
            <th scope="col" className="w-28 px-4 py-2.5 text-start font-normal">
              {t("columns.workspaces")}
            </th>
            <th scope="col" className="w-40 px-4 py-2.5 text-start font-normal">
              {t("columns.lastActive")}
            </th>
            <th scope="col" className="w-28 px-4 py-2.5 text-start font-normal">
              {t("columns.twoFactor")}
            </th>
            <th scope="col" className="w-36 px-4 py-2.5 text-start font-normal">
              {t("columns.password")}
            </th>
            <th scope="col" className="w-10">
              <span className="sr-only">{t("columns.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {users.map((u) => (
            <UserRow key={u.id} user={u} isSelf={u.id === currentUserId} emailReset={emailReset} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tag({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "accent" | "danger" }) {
  const tones = { muted: "text-fg-muted", accent: "text-accent", danger: "text-danger" };
  return <span className={`shrink-0 rounded bg-bg-hover px-1.5 py-0.5 text-xs ${tones[tone]}`}>{children}</span>;
}

function UserRow({ user, isSelf, emailReset, now }: { user: InstanceUser; isSelf: boolean; emailReset: boolean; now: Date }) {
  const t = useTranslations("admin.users");
  const format = useFormatter();
  const menu = useFloating<HTMLButtonElement>();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const name = user.name || user.email;
  // Admins change their own password on the account page; accounts without one sign in otherwise.
  const canRequireReset = !isSelf && user.hasPassword && !user.passwordResetRequired;

  return (
    <tr className="align-middle">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <UserAvatar name={name} image={user.image} size="md" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">{user.name}</span>
              {isSelf && <span className="text-fg-muted">{t("you")}</span>}
              {user.isAdmin && <Tag tone="accent">{t("admin")}</Tag>}
              {!user.emailVerified && <Tag>{t("unverified")}</Tag>}
            </div>
            <div className="truncate text-xs text-fg-muted">{user.email}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-fg-muted">{user.workspaces}</td>
      <td className="px-4 py-3 whitespace-nowrap text-fg-muted">
        {user.lastActiveAt ? (
          <time
            dateTime={user.lastActiveAt.toISOString()}
            title={format.dateTime(user.lastActiveAt, { dateStyle: "medium", timeStyle: "short" })}
          >
            {format.relativeTime(user.lastActiveAt, now)}
          </time>
        ) : (
          <span className="text-fg-faint">{t("signedOut")}</span>
        )}
      </td>
      <td className="px-4 py-3 text-fg-muted">{user.twoFactorEnabled ? t("on") : t("off")}</td>
      <td className="px-4 py-3">
        {user.passwordResetRequired ? (
          <Tag tone="danger">{t("resetPending")}</Tag>
        ) : (
          <span className="text-fg-muted">{user.hasPassword ? t("hasPassword") : t("noPassword")}</span>
        )}
      </td>
      <td className="px-1 py-2.5 text-end">
        <IconButton ref={menu.ref} label={t("actionsFor", { name })} onClick={menu.toggle}>
          <MoreHorizontal className="h-4 w-4" />
        </IconButton>
        {/* Portaled so the table's scroll container doesn't clip it. */}
        <Floating anchor={menu.el} open={menu.open} onClose={menu.close} align="end" className="text-start">
          <MenuItem
            disabled={user.sessions === 0}
            onClick={() => {
              menu.close();
              setConfirmation({
                title: t("signOutTitle", { name }),
                body: isSelf ? t("signOutSelfBody", { count: user.sessions }) : t("signOutBody", { count: user.sessions }),
                confirm: t("signOutConfirm"),
                action: () => signOutUserAction(user.id),
              });
            }}
          >
            {t("signOut")}
          </MenuItem>
          {canRequireReset && (
            <MenuItem
              danger
              onClick={() => {
                menu.close();
                setConfirmation({
                  title: t("resetTitle", { name }),
                  body: `${t("resetBody")} ${emailReset ? t("resetByEmail") : t("resetInApp")}`,
                  confirm: t("resetConfirm"),
                  action: () => requirePasswordResetAction(user.id),
                });
              }}
            >
              {t("requireReset")}
            </MenuItem>
          )}
        </Floating>
        {confirmation && <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />}
      </td>
    </tr>
  );
}
