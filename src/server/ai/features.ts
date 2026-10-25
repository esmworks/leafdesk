/**
 * Which model each AI feature runs on and how much it lets a model that thinks think, by the
 * request's `feature`. AI_MODEL answers everything unless the server also has AI_FAST_MODEL, which
 * then takes the short, simple jobs marked `fast`. A feature not listed runs on AI_MODEL with the
 * model's own thinking. See docs/ai.md.
 */
import type { AiThinking } from "./backend";

export type AiFeaturePlan = {
  /** Runs on AI_FAST_MODEL when the server has one; on AI_MODEL otherwise. */
  fast?: boolean;
  /** Unset: the model's own default (Claude 5.5: high effort). */
  thinking?: AiThinking;
  /**
   * Where there is no fast model (none on the server, or an own AI account), the request runs as
   * this feature instead: for features that ask for the fast model by choice rather than need.
   */
  orElse?: string;
};

/** A name ending in "." covers every feature it starts; the first match counts. */
const PLANS: [feature: string, plan: AiFeaturePlan][] = [
  // One short value per cell, for every row of a database, mostly in the background.
  ["property.", { fast: true, thinking: "off" }],
  // A transcript tidied into a note with a title and tags: the words are all there already.
  ["voice.rewrite", { fast: true, thinking: "low" }],
  // A meeting's summary, decisions and action items: picking what matters out of a long
  // transcript, once per meeting, so the main model with a little thinking.
  ["voice.meetingSummary", { thinking: "low" }],
  // The writing assistant stays on the main model: one request per click, and what it writes goes
  // straight into a page, where the larger model's wording and translations show. Fixed tasks on
  // a selection need little thinking; an instruction of the person's own may need more.
  ["editor.custom", { thinking: "medium" }],
  ["editor.", { thinking: "low" }],
  // A formula from a description, checked before it is offered: the main model (the language is
  // its own and the check sends failures back), with a little thinking while the person waits.
  ["formula.", { thinking: "low" }],
  // Questions over the workspace's pages, often with figures, while the person waits.
  ["chat", { thinking: "medium" }],
  // A report from many sources, written once while the person watches its steps: the model's own
  // thinking, as for an agent's work.
  ["chat.research", {}],
  // An agent drafted from an owner's description: instructions it will follow alone, so the main
  // model, while the owner waits for one answer.
  ["agent.draft", { thinking: "medium" }],
  // Databases drafted from a description: a schema the person builds on, while they wait for it.
  ["build.plan", { thinking: "medium" }],
  // Agents work alone over many steps, where a mistake is not caught by someone reading along.
  // One its owners set to the fast model does routine, well-defined work (summaries, sorting rows):
  // a little thinking keeps its steps on track without spending what the cheaper model saves.
  // Without a fast model it is an agent like any other.
  ["agent.fast", { fast: true, thinking: "low", orElse: "agent" }],
  ["agent", {}],
];

export function featurePlan(feature: string): AiFeaturePlan {
  const found = PLANS.find(([name]) => (name.endsWith(".") ? feature.startsWith(name) : feature === name));
  return found?.[1] ?? {};
}
