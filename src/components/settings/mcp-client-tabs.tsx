"use client";

import { useId, useState } from "react";
import { TabButton } from "./members-panel";
import { CopyButton } from "./copy-button";

export function Snippet({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-bg py-1.5 pe-1.5 ps-3">
      <code className="min-w-0 flex-1 text-xs break-all">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

export type McpClient = { id: string; title: string; body: string; command?: string };

/** One assistant's setup at a time, picked from a row of tabs. */
export function McpClientTabs({ label, clients }: { label: string; clients: McpClient[] }) {
  const [current, setCurrent] = useState(clients[0].id);
  const id = useId();
  const client = clients.find((c) => c.id === current) ?? clients[0];
  return (
    <div>
      <div className="overflow-x-auto [scrollbar-width:none]">
        <div role="tablist" aria-label={label} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5 whitespace-nowrap">
          {clients.map((c) => (
            <TabButton key={c.id} active={c.id === client.id} onClick={() => setCurrent(c.id)}>
              {c.title}
            </TabButton>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-label={client.title} className="mt-4 space-y-3">
        <p className="text-sm leading-relaxed text-fg-muted">{client.body}</p>
        {client.command && <Snippet value={client.command} />}
      </div>
    </div>
  );
}
