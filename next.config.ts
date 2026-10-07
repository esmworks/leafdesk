import { randomUUID } from "node:crypto";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import createNextIntlPlugin from "next-intl/plugin";

// One id per `next build`: Next writes it to .next/BUILD_ID, which the server reads at runtime, and
// it is compiled into the browser bundle, so a tab can tell it isn't running the server's build
// (see lib/build-id). Development has none: the bundle changes under an open tab all the time.
// Kept in the environment so build workers that load this file again inherit the same id.
const buildOnly = (phase: string): NextConfig => {
  if (phase !== PHASE_PRODUCTION_BUILD) return {};
  const buildId = (process.env.LEAFDESK_BUILD_ID ||= randomUUID());
  return { generateBuildId: () => buildId, env: { LEAFDESK_BUILD_ID: buildId } };
};

const config = (phase: string): NextConfig => ({
  ...buildOnly(phase),
  // Loaded by the custom server too; keep one copy of each in the process.
  serverExternalPackages: ["postgres", "@blocknote/server-util", "jsdom", "yjs", "nodemailer", "@earendil-works/pi-ai", "unpdf"],
  experimental: {
    // Dev only: with the debug channel React waits for debug data sent over the HMR websocket
    // before it hydrates or applies a navigation. The custom server restarts on every server
    // file change, and the new process doesn't know the old requests, so open tabs froze
    // (visible but dead). Without it the debug data is inlined in the RSC payload.
    reactDebugChannel: false,
  },
  // Dev only: Next prints every server action call with its arguments, and account actions take
  // passwords and two-step codes. Dev logs end up pasted into issues.
  logging: { serverFunctions: false },
  async rewrites() {
    // OAuth / MCP discovery documents must live at the origin root.
    return [{ source: "/.well-known/:path*", destination: "/api/well-known/:path*" }];
  },
});

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default function nextConfig(phase: string) {
  return withNextIntl(config(phase));
}
