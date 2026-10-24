"use client";

import dynamic from "next/dynamic";

/**
 * The "Build with AI" dialog (build-with-ai-dialog.tsx), loaded when it is first opened: the
 * sidebar, the home page and the editor offer it, and most visits never do.
 */
export const BuildWithAiDialog = dynamic(() => import("./build-with-ai-dialog").then((m) => m.BuildWithAiDialog), { ssr: false });

export type { BuildCreated, BuildTarget } from "./build-with-ai-dialog";
