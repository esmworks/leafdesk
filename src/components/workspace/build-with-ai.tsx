"use client";

import { lazyPart } from "@/components/lazy-part";

/**
 * The "Build with AI" dialog (build-with-ai-dialog.tsx), loaded when it is first opened: the
 * sidebar, the home page and the editor offer it, and most visits never do.
 */
export const BuildWithAiDialog = lazyPart(() => import("./build-with-ai-dialog").then((m) => m.BuildWithAiDialog));

export type { BuildCreated, BuildTarget } from "./build-with-ai-dialog";
