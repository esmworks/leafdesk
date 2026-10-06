import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const config: NextConfig = {
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
};

export default createNextIntlPlugin("./src/i18n/request.ts")(config);
