"use client";

import {
  Brain,
  ClipboardCheck,
  Keyboard,
  LayoutTemplate,
  LogOut,
  Monitor,
  Moon,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { setThemeAction } from "@/app/actions/theme";
import { InstallAppMenuItem } from "@/components/offline/install-app";
import { useChosenTheme } from "@/components/theme/theme-provider";
import { cn, MenuItem, MenuSeparator } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { comboText, isMac } from "@/lib/shortcuts";
import type { Theme } from "@/lib/theme";

export type AccountMenuProps = {
  close: () => void;
  workspaceId: string;
  pathname: string;
  user: { name: string; email: string; image: string | null };
  guest: boolean;
  offline: boolean;
  /** Making pages from templates needs the top level. */
  templates: boolean;
  customizing: boolean;
  instanceAdmin: boolean;
  /** The workspace has AI: what it keeps about the person is a page of its own. */
  memory: boolean;
  /** Why something needs the server, while offline. */
  needsServer: (label: string) => string | undefined;
  go: (path: string) => void;
  onTemplates: () => void;
  onImport: () => void;
  onTrash: () => void;
  onCustomize: () => void;
  onShortcuts: () => void;
  onSignOut: () => void;
};

/**
 * What the account button at the foot of the sidebar's rail opens: the person's account, the places and
 * tools opened now and then, the theme and signing out. Loaded the first time it opens (sidebar.tsx).
 */
export function AccountMenu(props: AccountMenuProps) {
  const { close, workspaceId, pathname, user, guest, offline, needsServer, go } = props;
  const t = useTranslations("sidebar");
  const tShortcuts = useTranslations("shortcuts");
  const run = (action: () => void) => () => {
    close();
    action();
  };
  const place = (path: string) => `/w/${workspaceId}/${path}`;
  return (
    <>
      {/* Who is signed in; opens their account page (profile, password, sessions, …). */}
      <button
        type="button"
        title={t("workspaceMenu.myAccount")}
        onClick={run(() => go(place("settings?tab=profile")))}
        className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-start hover:bg-bg-hover"
      >
        <UserAvatar name={user.name || user.email} image={user.image} size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{user.name || user.email}</span>
          <span className="block truncate text-xs text-fg-muted">{user.email}</span>
        </span>
      </button>
      <MenuSeparator />
      {/* The people directory, like the members list, isn't for guests. */}
      {!guest && (
        <MenuItem icon={<Users className="h-4 w-4" />} active={pathname === place("people")} onClick={run(() => go(place("people")))}>
          {t("nav.people")}
        </MenuItem>
      )}
      <MenuItem
        icon={<ClipboardCheck className="h-4 w-4" />}
        active={pathname === place("review")}
        disabled={offline}
        title={needsServer(t("nav.review"))}
        onClick={run(() => go(place("review")))}
      >
        {t("nav.review")}
      </MenuItem>
      {/* The skills library: guests see the skills shared with them. */}
      <MenuItem
        icon={<ScrollText className="h-4 w-4" />}
        active={pathname === place("skills")}
        disabled={offline}
        title={needsServer(t("nav.skills"))}
        onClick={run(() => go(place("skills")))}
      >
        {t("nav.skills")}
      </MenuItem>
      {/* What the AI keeps about the person, beside the skills it works with; the chat's header links there too. */}
      {props.memory && (
        <MenuItem
          icon={<Brain className="h-4 w-4" />}
          active={pathname === place("memory")}
          disabled={offline}
          title={needsServer(t("nav.memory"))}
          onClick={run(() => go(place("memory")))}
        >
          {t("nav.memory")}
        </MenuItem>
      )}
      <MenuItem icon={<Trash2 className="h-4 w-4" />} disabled={offline} title={needsServer(t("nav.trash"))} onClick={run(props.onTrash)}>
        {t("nav.trash")}
      </MenuItem>
      <MenuSeparator />
      {/* Templates live here rather than in the page tree; making pages from them needs the top level. */}
      {props.templates && (
        <MenuItem icon={<LayoutTemplate className="h-4 w-4" />} disabled={offline} title={needsServer(t("nav.templates"))} onClick={run(props.onTemplates)}>
          {t("nav.templates")}
        </MenuItem>
      )}
      <MenuItem icon={<Upload className="h-4 w-4" />} disabled={offline} title={needsServer(t("nav.import"))} onClick={run(props.onImport)}>
        {t("nav.import")}
      </MenuItem>
      <MenuItem icon={<SlidersHorizontal className="h-4 w-4" />} pressed={props.customizing} onClick={run(props.onCustomize)}>
        {t("customize.open")}
      </MenuItem>
      <MenuSeparator />
      <ThemeChoice />
      <MenuItem
        icon={<Keyboard className="h-4 w-4" />}
        trailing={<kbd className="font-sans text-xs text-fg-faint pointer-coarse:hidden">{comboText(["Mod", "/"], isMac())}</kbd>}
        onClick={run(props.onShortcuts)}
      >
        {tShortcuts("title")}
      </MenuItem>
      {props.instanceAdmin && (
        <MenuItem icon={<ShieldCheck className="h-4 w-4" />} onClick={run(() => go(`/admin?from=${encodeURIComponent(workspaceId)}`))}>
          {t("workspaceMenu.admin")}
        </MenuItem>
      )}
      <InstallAppMenuItem onDone={close} />
      <MenuSeparator />
      <MenuItem icon={<LogOut className="h-4 w-4" />} disabled={offline} title={needsServer(t("workspaceMenu.signOut"))} onClick={run(props.onSignOut)}>
        {t("workspaceMenu.signOut")}
      </MenuItem>
    </>
  );
}

const CHOICES: { value: Theme | null; key: "light" | "dark" | "system"; Icon: typeof Sun }[] = [
  { value: "light", key: "light", Icon: Sun },
  { value: "dark", key: "dark", Icon: Moon },
  { value: null, key: "system", Icon: Monitor },
];

/** Light, dark or the system's, for this browser: the same choice as Settings → Preferences. */
function ThemeChoice() {
  const t = useTranslations("sidebar.accountMenu");
  const { theme, setTheme } = useChosenTheme();
  return (
    <div role="group" aria-label={t("theme")} className="flex items-center gap-2 px-2 py-1">
      <span className="flex-1 truncate text-sm">{t("theme")}</span>
      <div className="flex rounded-md bg-bg-hover p-0.5">
        {CHOICES.map(({ value, key, Icon }) => (
          <button
            key={key}
            type="button"
            aria-label={t(key)}
            title={t(key)}
            aria-pressed={theme === value}
            onClick={() => {
              setTheme(value);
              void setThemeAction(value);
            }}
            className={cn("flex h-6 w-7 items-center justify-center rounded text-fg-muted hover:text-fg", theme === value && "bg-bg text-fg shadow-sm")}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}
