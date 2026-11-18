"use client";

import dynamic from "next/dynamic";

/** The settings of an agent run elsewhere, in a chunk of its own: the agent settings page shows it only for those agents. */
export const ExternalAgentEditorPart = dynamic(() => import("./external-agent-editor").then((m) => m.ExternalAgentEditor));
