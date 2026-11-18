"use client";

import dynamic from "next/dynamic";

/** The Teams link card, in a chunk of its own: only servers with a Teams bot show it. */
export const TeamsLinkPart = dynamic(() => import("./teams-link").then((m) => m.TeamsLink));
