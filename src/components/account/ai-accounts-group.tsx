import { requireUser } from "@/server/session";
import { listAiAccounts } from "@/server/ai-accounts";
import { AiAccountsSettings } from "./ai-accounts";

/** Settings > Apps > AI, while the server takes people's own AI keys (OWN_AI_KEYS_ENABLED). */
export async function AiAccountsGroup() {
  const user = await requireUser();
  return <AiAccountsSettings initial={await listAiAccounts(user.id)} />;
}
