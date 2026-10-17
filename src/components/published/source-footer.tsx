import { getTranslations } from "next-intl/server";
import { APP_INFO } from "@/server/app-info";

/**
 * Where to get the source code of the server, under the pages anyone may open without an account
 * (published pages, public forms): the About tab only reaches people who sign in.
 */
export async function SourceFooter() {
  const t = await getTranslations("common");
  return (
    <footer className="px-4 pb-6 text-center text-xs text-fg-faint">
      <a href={APP_INFO.source} target="_blank" rel="noreferrer" className="hover:text-fg-muted hover:underline">
        {t("sourceCode")}
      </a>
    </footer>
  );
}
