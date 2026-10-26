import { getTranslations } from "next-intl/server";
import type { GithubPullsNames } from "@/lib/github-pulls-sync";
import type { IcalNames } from "@/lib/ical-sync";
import type { JiraNames } from "@/lib/jira-sync";
import type { BoardNames } from "@/server/import/board";
import type { EnexNames } from "@/server/import/enex";
import type { TrelloNames } from "@/server/import/trello";
import type { DatabaseSeedNames } from "@/server/pages";

/** Starter property, option and view names for a new database, in the user's language. */
export async function databaseSeedNames(): Promise<DatabaseSeedNames> {
  const t = await getTranslations("database");
  return {
    status: t("page.defaultGroupProperty"),
    notStarted: t("page.defaultGroupOptions.notStarted"),
    inProgress: t("page.defaultGroupOptions.inProgress"),
    done: t("page.defaultGroupOptions.done"),
    tags: t("page.defaultTagsProperty"),
    table: t("views.table"),
  };
}

/** Names of what a Trello import creates (properties, the board view, body headings), in the user's language. */
export async function trelloImportNames(): Promise<TrelloNames> {
  const [t, td] = await Promise.all([getTranslations("import.trello.names"), getTranslations("database")]);
  return {
    list: t("list"),
    labels: t("labels"),
    members: t("members"),
    otherMembers: t("otherMembers"),
    dates: t("dates"),
    complete: t("complete"),
    checklist: t("checklist"),
    link: t("link"),
    attachments: t("attachments"),
    comments: t("comments"),
    board: td("views.board"),
    colors: {
      gray: td("colors.gray"),
      brown: td("colors.brown"),
      orange: td("colors.orange"),
      yellow: td("colors.yellow"),
      green: td("colors.green"),
      blue: td("colors.blue"),
      purple: td("colors.purple"),
      pink: td("colors.pink"),
      red: td("colors.red"),
    },
  };
}

/** Names of what an Asana or Monday.com import creates (properties, the board view, body headings), in the user's language. */
export async function boardImportNames(): Promise<BoardNames> {
  const [t, td] = await Promise.all([getTranslations("import.board.names"), getTranslations("database")]);
  return {
    section: t("section"),
    group: t("group"),
    status: t("status"),
    toDo: t("toDo"),
    done: t("done"),
    assignee: t("assignee"),
    tags: t("tags"),
    dates: t("dates"),
    others: (column) => t("others", { column }),
    parentItem: td("subItems.parentName"),
    subItems: td("subItems.subItemsName"),
    blockedBy: td("dependencies.blockedByName"),
    blocking: td("dependencies.blockingName"),
    attachments: t("attachments"),
    comments: t("comments"),
    board: td("views.board"),
  };
}

/** Names of what an Evernote import creates (properties, the line for encrypted text), in the user's language. */
export async function enexImportNames(): Promise<EnexNames> {
  const t = await getTranslations("import.evernote.names");
  return {
    tags: t("tags"),
    created: t("created"),
    updated: t("updated"),
    author: t("author"),
    sourceUrl: t("sourceUrl"),
    encrypted: t("encrypted"),
  };
}

/** Names of the properties and view a Jira sync creates, in the user's language. */
export async function jiraSyncNames(): Promise<JiraNames> {
  const [t, td] = await Promise.all([getTranslations("import.jira.names"), getTranslations("database")]);
  return {
    key: t("key"),
    status: t("status"),
    assignee: t("assignee"),
    reporter: t("reporter"),
    others: (column) => t("others", { column }),
    priority: t("priority"),
    type: t("type"),
    labels: t("labels"),
    due: t("due"),
    link: t("link"),
    board: td("views.board"),
  };
}

export async function githubPullsNames(): Promise<GithubPullsNames> {
  const [t, td] = await Promise.all([getTranslations("import.githubPulls.names"), getTranslations("database")]);
  return {
    number: t("number"),
    state: t("state"),
    author: t("author"),
    assignees: t("assignees"),
    others: (column) => t("others", { column }),
    labels: t("labels"),
    branch: t("branch"),
    base: t("base"),
    created: t("created"),
    merged: t("merged"),
    link: t("link"),
    board: td("views.board"),
    stages: { draft: t("stages.draft"), open: t("stages.open"), merged: t("stages.merged"), closed: t("stages.closed") },
  };
}

/** Names of what a calendar sync creates (properties, status options, the calendar view), in the user's language. */
export async function icalNames(): Promise<IcalNames> {
  const [t, td] = await Promise.all([getTranslations("import.ical.names"), getTranslations("database")]);
  return {
    key: t("key"),
    when: t("when"),
    location: t("location"),
    description: t("description"),
    status: t("status"),
    organizer: t("organizer"),
    link: t("link"),
    untitled: t("untitled"),
    calendar: td("views.calendar"),
    statuses: { confirmed: t("statuses.confirmed"), tentative: t("statuses.tentative"), cancelled: t("statuses.cancelled") },
  };
}
