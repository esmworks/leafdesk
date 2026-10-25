// Better Auth under /api/auth: sign-in, sessions and the OAuth provider for MCP clients.
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
