"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { createPageAction } from "@/app/actions/pages";
import { markNewPage } from "@/components/page/new-page-focus";

/** Makes a private page in the workspace and opens it in place of `/new` (app/new). */
export function NewPageStarter({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("page.newPageRoute");
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  // Once, also when React runs the effect twice in development.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    createPageAction({ workspaceId, teamspaceId: null }).then(
      (page) => {
        // The caret goes to the title, as for any page just made.
        markNewPage(page.id);
        router.replace(`/w/${workspaceId}/p/${page.id}`);
      },
      () => setFailed(true),
    );
  }, [workspaceId, router]);

  return (
    <main className="flex min-h-full items-center justify-center bg-bg px-4 text-sm text-fg-muted">
      {failed ? (
        <p role="alert">
          {t("failed")}{" "}
          <Link href={`/w/${workspaceId}`} className="text-accent underline-offset-2 hover:underline">
            {t("home")}
          </Link>
        </p>
      ) : (
        <p aria-live="polite">{t("creating")}</p>
      )}
    </main>
  );
}
