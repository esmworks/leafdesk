"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { Button, Input, selectClass, Switch } from "@/components/ui";
import type { WorkspaceSettings } from "@/db/schema";
import { HISTORY_RETENTION, TRASH_RETENTION_CHOICES } from "@/lib/retention";
import { SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

/** The settings chosen from a list: who may do something, or how far connected apps go. */
type ChoiceSetting = "guestInvites" | "publishing" | "connectedApps";

/** Each setting's choices, with the message naming each (under settings.security). */
const CHOICES = {
  guestInvites: {
    id: "guest-invites",
    options: [
      ["owners", "guestInvites.owners"],
      ["members", "guestInvites.members"],
    ],
  },
  publishing: {
    id: "publishing",
    options: [
      ["owners", "publishing.owners"],
      ["members", "publishing.members"],
      ["off", "publishing.off"],
    ],
  },
  connectedApps: {
    id: "connected-apps",
    options: [
      ["full", "connectedApps.full"],
      ["read", "connectedApps.read"],
      ["off", "connectedApps.off"],
    ],
  },
} as const satisfies { [K in ChoiceSetting]: { id: string; options: readonly (readonly [WorkspaceSettings[K], string])[] } };

/** Settings > Security: a policy picked from a few choices, each with its own label. */
function ChoiceSettingSelect({
  workspaceId,
  settings,
  canEdit,
  setting,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  canEdit: boolean;
  setting: ChoiceSetting;
}) {
  const t = useTranslations("settings.security");
  const [value, setValue] = useState<string>(settings[setting]);
  const { pending, error, run } = useAction();
  const { id, options } = CHOICES[setting];

  return (
    <SettingsRow
      title={t(`${setting}.title`)}
      htmlFor={id}
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            {t(`${setting}.description`)}
            {!canEdit && <> {t("ownersOnly")}</>}
          </>
        )
      }
      control={
        <select
          id={id}
          className={selectClass}
          value={value}
          disabled={!canEdit || pending}
          onChange={(e) => {
            const next = e.target.value;
            const previous = value;
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { [setting]: next });
              if (!result.ok) setValue(previous);
              return result;
            });
          }}
        >
          {options.map(([option, label]) => (
            <option key={option} value={option}>
              {t(label)}
            </option>
          ))}
        </select>
      }
    />
  );
}

/** Settings > Security: workspace policies. Owners change them; members see what is set. */
export function GuestInviteSetting(props: { workspaceId: string; settings: WorkspaceSettings; canEdit: boolean }) {
  return <ChoiceSettingSelect {...props} setting="guestInvites" />;
}

/** Owners only, owners and members, or nobody: off also takes what is published off the web. */
export function PublishingSetting(props: { workspaceId: string; settings: WorkspaceSettings; canEdit: boolean }) {
  return <ChoiceSettingSelect {...props} setting="publishing" />;
}

/** What MCP clients and REST API tokens may do here: everything their user may, read, or nothing. */
export function ConnectedAppsSetting(props: { workspaceId: string; settings: WorkspaceSettings; canEdit: boolean }) {
  return <ChoiceSettingSelect {...props} setting="connectedApps" />;
}

/** Whether people may export pages (Markdown, CSV, ZIP) and print them to PDF. */
export function ExportSetting({
  workspaceId,
  settings,
  canEdit,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  canEdit: boolean;
}) {
  const t = useTranslations("settings.security");
  const [value, setValue] = useState(settings.export !== false);
  const { pending, error, run } = useAction();

  return (
    <SettingsRow
      title={t("export.title")}
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            {t("export.description")}
            {!canEdit && <> {t("ownersOnly")}</>}
          </>
        )
      }
      control={
        <Switch
          checked={value}
          label={t("export.title")}
          disabled={!canEdit || pending}
          onChange={(next) => {
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { export: next });
              if (!result.ok) setValue(!next);
              return result;
            });
          }}
        />
      }
    />
  );
}

/** Whether guests may add top-level pages that only they can see. */
export function GuestPrivatePagesSetting({
  workspaceId,
  settings,
  canEdit,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  canEdit: boolean;
}) {
  const t = useTranslations("settings.security");
  const [value, setValue] = useState(settings.guestPrivatePages);
  const { pending, error, run } = useAction();

  return (
    <SettingsRow
      title={t("guestPrivatePages.title")}
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            {t("guestPrivatePages.description")}
            {!canEdit && <> {t("ownersOnly")}</>}
          </>
        )
      }
      control={
        <Switch
          checked={value}
          label={t("guestPrivatePages.title")}
          disabled={!canEdit || pending}
          onChange={(next) => {
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { guestPrivatePages: next });
              if (!result.ok) setValue(!next);
              return result;
            });
          }}
        />
      }
    />
  );
}

/** Whether people who open a link to a page they can't see may ask for access to it. */
export function AccessRequestsSetting({
  workspaceId,
  settings,
  canEdit,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  canEdit: boolean;
}) {
  const t = useTranslations("settings.security");
  const [value, setValue] = useState(settings.accessRequests);
  const { pending, error, run } = useAction();

  return (
    <SettingsRow
      title={t("accessRequests.title")}
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            {t("accessRequests.description")}
            {!canEdit && <> {t("ownersOnly")}</>}
          </>
        )
      }
      control={
        <Switch
          checked={value}
          label={t("accessRequests.title")}
          disabled={!canEdit || pending}
          onChange={(next) => {
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { accessRequests: next });
              if (!result.ok) setValue(!next);
              return result;
            });
          }}
        />
      }
    />
  );
}

/**
 * Whether everyone must use two-step verification to open the workspace. Turning it on needs the
 * owner's own session to pass it, so they can't shut themselves out; the server checks it too.
 */
export function RequireTwoFactorSetting({
  workspaceId,
  settings,
  canEdit,
  ownSessionPasses,
  withoutTwoFactor,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  canEdit: boolean;
  /** The owner's current session counts as two-step (authenticator app on, or a passkey sign-in). */
  ownSessionPasses: boolean;
  /** People in the workspace with neither an authenticator app nor a passkey (owners only). */
  withoutTwoFactor: number;
}) {
  const t = useTranslations("settings.security.requireTwoFactor");
  const ts = useTranslations("settings.security");
  const [value, setValue] = useState(settings.requireTwoFactor);
  const { pending, error, run } = useAction();
  const blocked = !value && !ownSessionPasses;

  return (
    <SettingsRow
      title={t("title")}
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            {t("description")}
            {!canEdit && <> {ts("ownersOnly")}</>}
            {canEdit && blocked && (
              <>
                {" "}
                <Link href={`/w/${workspaceId}/settings?tab=accountSecurity`} className="text-accent hover:underline">
                  {t("setUpFirst")}
                </Link>
              </>
            )}
            {canEdit && !blocked && withoutTwoFactor > 0 && <> {t("withoutCount", { count: withoutTwoFactor })}</>}
          </>
        )
      }
      control={
        <Switch
          checked={value}
          label={t("title")}
          disabled={!canEdit || pending || blocked}
          onChange={(next) => {
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { requireTwoFactor: next });
              if (!result.ok) setValue(!next);
              return result;
            });
          }}
        />
      }
    />
  );
}

type MemberChoiceKey = "memberInvites" | "domainJoin" | "joinRequests";
const MEMBER_CHOICES: { [K in MemberChoiceKey]: readonly WorkspaceSettings[K][] } = {
  memberInvites: ["owners", "members_with_approval", "any_member"],
  domainJoin: ["join", "request"],
  joinRequests: ["nobody", "allowed_domains", "anyone_with_link"],
};

/** Settings > Security > Members: one policy with a few choices, as a select. */
function MemberChoiceSetting<K extends MemberChoiceKey>({
  workspaceId,
  settings,
  canEdit,
  setting,
  disabled = false,
  hint,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  canEdit: boolean;
  setting: K;
  /** Shown but not changeable (it has no effect right now). */
  disabled?: boolean;
  hint?: string;
}) {
  const t = useTranslations("settings.security");
  const [value, setValue] = useState<WorkspaceSettings[K]>(settings[setting]);
  const { pending, error, run } = useAction();
  const id = `setting-${setting}`;
  const choices = MEMBER_CHOICES[setting] as readonly string[];
  // Widened from K so the message keys below resolve to a plain union.
  const key: MemberChoiceKey = setting;

  return (
    <SettingsRow
      title={t(`${key}.title`)}
      htmlFor={id}
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            {t(`${key}.description`)}
            {hint && <> {hint}</>}
            {!canEdit && <> {t("ownersOnly")}</>}
          </>
        )
      }
      control={
        <select
          id={id}
          className={selectClass}
          value={value as string}
          disabled={!canEdit || pending || disabled}
          onChange={(e) => {
            const next = e.target.value as WorkspaceSettings[K];
            const previous = value;
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { [setting]: next });
              if (!result.ok) setValue(previous);
              return result;
            });
          }}
        >
          {choices.map((choice) => (
            // Keys like `memberInvites.any_member`; every choice has its label.
            <option key={choice} value={choice}>
              {t(`${key}.${choice}` as Parameters<typeof t>[0])}
            </option>
          ))}
        </select>
      }
    />
  );
}

/**
 * Settings > Security > Members: who may add members, which email domains may come in on their own
 * and how, and who may ask to join. The server enforces all of it (server/join-requests.ts).
 */
export function MembershipSettings({
  workspaceId,
  settings,
  canEdit,
  mailEnabled,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  canEdit: boolean;
  /** Whether the server sends email, so password accounts can verify their address. */
  mailEnabled: boolean;
}) {
  const t = useTranslations("settings.security");
  const [domains, setDomains] = useState(settings.allowedDomains);
  const [joinRequests, setJoinRequests] = useState(settings.joinRequests);

  return (
    <>
      <MemberChoiceSetting workspaceId={workspaceId} settings={settings} canEdit={canEdit} setting="memberInvites" />
      <AllowedDomainsSetting
        workspaceId={workspaceId}
        domains={domains}
        canEdit={canEdit}
        mailEnabled={mailEnabled}
        onSaved={setDomains}
      />
      <MemberChoiceSetting
        workspaceId={workspaceId}
        settings={settings}
        canEdit={canEdit}
        setting="domainJoin"
        disabled={domains.length === 0}
        hint={domains.length === 0 ? t("domainJoin.noDomains") : undefined}
      />
      <JoinRequestsChoice
        workspaceId={workspaceId}
        settings={{ ...settings, joinRequests }}
        canEdit={canEdit}
        onChange={setJoinRequests}
      />
    </>
  );
}

/** "Who can ask to join", explaining what "anyone with the join link" does to the link. */
function JoinRequestsChoice({
  workspaceId,
  settings,
  canEdit,
  onChange,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  canEdit: boolean;
  onChange: (value: WorkspaceSettings["joinRequests"]) => void;
}) {
  const t = useTranslations("settings.security.joinRequests");
  const ts = useTranslations("settings.security");
  const [value, setValue] = useState(settings.joinRequests);
  const { pending, error, run } = useAction();

  return (
    <SettingsRow
      title={t("title")}
      htmlFor="setting-joinRequests"
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            {t("description")}
            {value === "anyone_with_link" && <> {t("linkHint")}</>}
            {!canEdit && <> {ts("ownersOnly")}</>}
          </>
        )
      }
      control={
        <select
          id="setting-joinRequests"
          className={selectClass}
          value={value}
          disabled={!canEdit || pending}
          onChange={(e) => {
            const next = e.target.value as WorkspaceSettings["joinRequests"];
            const previous = value;
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { joinRequests: next });
              if (result.ok) onChange(next);
              else setValue(previous);
              return result;
            });
          }}
        >
          {MEMBER_CHOICES.joinRequests.map((choice) => (
            <option key={choice} value={choice}>
              {t(choice)}
            </option>
          ))}
        </select>
      }
    />
  );
}

/** The allowed email domains, typed as a list; the server cleans them up and refuses public mail services. */
function AllowedDomainsSetting({
  workspaceId,
  domains,
  canEdit,
  mailEnabled,
  onSaved,
}: {
  workspaceId: string;
  domains: string[];
  canEdit: boolean;
  mailEnabled: boolean;
  onSaved: (domains: string[]) => void;
}) {
  const t = useTranslations("settings.security.allowedDomains");
  const ts = useTranslations("settings.security");
  const tc = useTranslations("common");
  const [text, setText] = useState(domains.join(", "));
  const [saved, setSaved] = useState(false);
  const { pending, error, run } = useAction();
  const typed = text
    .split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  const dirty = typed.join(",") !== domains.join(",");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty) return;
        setSaved(false);
        run(
          () => updateWorkspaceSettingsAction(workspaceId, { allowedDomains: typed }),
          () => {
            setSaved(true);
            onSaved(typed);
          },
        );
      }}
    >
      <SettingsRow
        title={t("title")}
        htmlFor="allowed-domains"
        description={
          error ? (
            <span className="text-danger">{error}</span>
          ) : (
            <>
              {saved ? tc("saved") : t("description")} {mailEnabled ? t("verifiedByEmail") : t("verifiedByProvider")}
              {!canEdit && <> {ts("ownersOnly")}</>}
            </>
          )
        }
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="allowed-domains"
            value={text}
            placeholder={t("placeholder")}
            disabled={!canEdit}
            className="w-full"
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
          />
          {canEdit && (
            <Button type="submit" variant="primary" disabled={!dirty || pending}>
              {pending ? tc("saving") : tc("save")}
            </Button>
          )}
        </div>
      </SettingsRow>
    </form>
  );
}

/** Settings > Security: how long pages stay in the trash before the daily cleanup deletes them. */
export function TrashRetentionSetting({
  workspaceId,
  settings,
  canEdit,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  canEdit: boolean;
}) {
  const t = useTranslations("settings.security.trashRetention");
  const ts = useTranslations("settings.security");
  const [value, setValue] = useState(settings.trashRetentionDays);
  const { pending, error, run } = useAction();

  return (
    <SettingsRow
      title={t("title")}
      htmlFor="trash-retention"
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            {t("description")}
            {!canEdit && <> {ts("ownersOnly")}</>}
          </>
        )
      }
      control={
        <select
          id="trash-retention"
          className={selectClass}
          value={value}
          disabled={!canEdit || pending}
          onChange={(e) => {
            const next = Number(e.target.value);
            const previous = value;
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { trashRetentionDays: next });
              if (!result.ok) setValue(previous);
              return result;
            });
          }}
        >
          {TRASH_RETENTION_CHOICES.map((days) => (
            <option key={days} value={days}>
              {days === 0 ? t("never") : t("days", { count: days })}
            </option>
          ))}
        </select>
      }
    />
  );
}

/** Settings > Security: the page history rules, the same for every workspace. */
export function HistoryRetentionNote() {
  const t = useTranslations("settings.security.historyRetention");
  return (
    <SettingsRow
      title={t("title")}
      description={t("description", {
        days: HISTORY_RETENTION.maxAgeDays,
        count: HISTORY_RETENTION.maxPerPage,
        keptDays: HISTORY_RETENTION.keptAgeDays,
      })}
    />
  );
}
