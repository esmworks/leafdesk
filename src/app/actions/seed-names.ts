import { getTranslations } from "next-intl/server";
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
