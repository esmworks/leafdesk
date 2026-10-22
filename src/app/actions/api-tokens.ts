"use server";

import { revalidatePath } from "next/cache";
import { WorkspacePolicyError } from "@/server/access";
import { ApiTokenError, createApiToken, revokeApiToken, updateApiTokenScopes } from "@/server/api/tokens";
import { policyGatePath, requireUserId } from "@/server/session";

export type CreateApiTokenResult =
  | { ok: true; secret: string }
  | { ok: false; error: ApiTokenError["code"] | "generic" }
  /** A workspace's sign-in policy holds the session back: `gate` is where it meets the policy. */
  | { ok: false; error: "policy"; gate: string };

/** Creates a personal access token; its secret comes back once and is never shown again. */
export async function createApiTokenAction(input: {
  name: string;
  scopes: string[];
  workspaceId: string | null;
  expiresInDays: number | null;
}): Promise<CreateApiTokenResult> {
  const userId = await requireUserId();
  try {
    const { secret } = await createApiToken(userId, {
      name: String(input.name ?? ""),
      scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : [],
      workspaceId: input.workspaceId,
      expiresInDays: input.expiresInDays,
    });
    revalidatePath("/w/[workspaceId]/settings", "page");
    return { ok: true, secret };
  } catch (error) {
    if (error instanceof ApiTokenError) return { ok: false, error: error.code };
    if (error instanceof WorkspacePolicyError) return { ok: false, error: "policy", gate: policyGatePath(error.workspaceId, error.hold) };
    console.error("could not create an API token", error);
    return { ok: false, error: "generic" };
  }
}

export type UpdateApiTokenResult = { ok: true } | { ok: false; error: "scopes" | "notFound" | "generic" };

/** Changes what one of the user's tokens may do; its secret stays the same. */
export async function updateApiTokenScopesAction(tokenId: string, scopes: string[]): Promise<UpdateApiTokenResult> {
  const userId = await requireUserId();
  try {
    await updateApiTokenScopes(userId, String(tokenId), Array.isArray(scopes) ? scopes.map(String) : []);
    revalidatePath("/w/[workspaceId]/settings", "page");
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiTokenError && (error.code === "scopes" || error.code === "notFound")) return { ok: false, error: error.code };
    console.error("could not change an API token's scopes", error);
    return { ok: false, error: "generic" };
  }
}

export async function revokeApiTokenAction(tokenId: string) {
  const userId = await requireUserId();
  await revokeApiToken(userId, String(tokenId));
  revalidatePath("/w/[workspaceId]/settings", "page");
}
