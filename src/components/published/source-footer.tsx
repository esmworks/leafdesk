import { getTranslations } from "next-intl/server";
import { APP_INFO } from "@/server/app-info";

/**
 * Where to get the source code of the server, under the pages anyone may open without an account
 * (published pages, public forms): the About tab only reaches people who sign in. On a published
 * page, `reportHref` leads to the form that reports it to the workspace's owners.
 */
export async function SourceFooter({ reportHref }: { reportHref?: string } = {}) {
  const [t, tp] = await Promise.all([getTranslations("common"), getTranslations("publish.report")]);
  return (
    <footer className="flex justify-center gap-3 px-4 pb-6 text-center text-xs text-fg-faint">
      {reportHref && (
        <a href={reportHref} rel="nofollow" className="hover:text-fg-muted hover:underline">
          {tp("link")}
        </a>
      )}
      <a href={APP_INFO.source} target="_blank" rel="noreferrer" className="hover:text-fg-muted hover:underline">
        {t("sourceCode")}
      </a>
    </footer>
  );
}
