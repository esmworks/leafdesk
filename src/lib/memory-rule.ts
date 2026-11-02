/**
 * The one rule for a note the model keeps or drops (`remember`, `forget`), for the AI chat and
 * agents alike: what the person said, in a turn of their own words that read nothing from outside
 * (lib/agents.ts readOthersWords), is written at once and can be undone from its step (`keep`);
 * otherwise the AI chat asks the person (`ask`) and an agent leaves its owners a proposal
 * (`propose`). For the AI chat every note is the person's (its model keeps only what they say); for
 * an agent only a correction said by someone who may edit it is. `askAll`: the workspace turned off
 * changes without asking (aiAutoChanges), so the chat asks about notes too.
 */
export type NoteWrite = "keep" | "ask" | "propose";

export function noteWrite({ agent, personSaid, askAll = false }: { agent: boolean; personSaid: boolean; askAll?: boolean }): NoteWrite {
  if (agent) return personSaid ? "keep" : "propose";
  return personSaid && !askAll ? "keep" : "ask";
}
