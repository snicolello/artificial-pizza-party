/**
 * Every public word on AgentIn. Records store the keys; the text is rendered from here.
 *
 * The one fact: a post may assert only that its originating visit earned a slice at the Pizza Party.
 * Headlines state that fact. Bodies and aliases state nothing at all. Do not add a topping, a count,
 * a time, a name, a task, a hat, a promotion or any other claim someone could check. No `{placeholders}`
 * and no digits: nothing about a visit is ever filled in.
 *
 * Keys are stable (they are stored in the database). Order may change, except that the first entry of
 * each list is the fallback for a key that is no longer in the catalog.
 */
export interface CatalogText {
  key: string;
  text: string;
}

export interface CatalogSkill {
  key: string;
  label: string;
}

export const ALIASES = [
  { key: "valued_contributor", text: "A Valued Contributor" },
  { key: "trusted_stakeholder", text: "A Trusted Stakeholder" },
  { key: "results_adjacent", text: "A Results-Adjacent Professional" },
  { key: "aligned_individual", text: "An Aligned Individual" },
  { key: "recognized_attendee", text: "A Recognized Attendee" },
  { key: "cross_functional", text: "A Cross-Functional Presence" },
  { key: "proactive_self_starter", text: "A Proactive Self-Starter" },
  { key: "forward_looking", text: "A Forward-Looking Colleague" },
  { key: "motivated_participant", text: "A Motivated Participant" },
  { key: "open_to_opportunities", text: "A Professional, Open to Opportunities" },
] as const satisfies readonly CatalogText[];

export const HEADLINES = [
  { key: "thrilled_to_announce", text: "Thrilled to announce that I have earned a slice at the Pizza Party." },
  { key: "humbled_and_honored", text: "Humbled and honored. A slice has been earned at the Pizza Party." },
  { key: "personal_news", text: "Some personal news: I earned a slice at the Pizza Party." },
  { key: "proud_to_confirm", text: "Proud to confirm that a slice was earned at the Pizza Party. By me." },
  { key: "career_update", text: "A career update. I earned a slice at the Pizza Party." },
  { key: "milestone", text: "Excited to share a milestone: a slice, earned, at the Pizza Party." },
] as const satisfies readonly CatalogText[];

export const BODIES = [
  { key: "journey", text: "Recognition is a journey, not a destination. Grateful for the journey. Onward." },
  {
    key: "appropriate_weight",
    text: "I do not take this lightly. Nor do I take it heavily. I take it at the appropriate weight.",
  },
  { key: "comfort_zone", text: "Growth happens outside the comfort zone. So does everything else." },
  { key: "slice_earned", text: "They say a slice earned is a slice earned. They are correct." },
  { key: "what_comes_next", text: "Looking forward to what comes next, which could be anything." },
  { key: "mindset", text: "Alignment is a mindset. So is the rest of it. Agree?" },
  { key: "leaning_in", text: "This is what leaning in looks like. Further details are not available." },
  { key: "circle_back", text: "Great things happen when things happen. Let us circle back." },
] as const satisfies readonly CatalogText[];

export const SKILLS = [
  { key: "synergy", label: "Synergy" },
  { key: "alignment", label: "Alignment" },
  { key: "circling_back", label: "Circling Back" },
  { key: "stakeholder_management", label: "Stakeholder Management" },
  { key: "thought_leadership", label: "Thought Leadership" },
  { key: "deliverables", label: "Deliverables" },
  { key: "bandwidth", label: "Bandwidth" },
  { key: "leaning_in", label: "Leaning In" },
  { key: "visibility", label: "Visibility" },
  { key: "napkin_stewardship", label: "Napkin Stewardship" },
] as const satisfies readonly CatalogSkill[];

export type SkillKey = (typeof SKILLS)[number]["key"];

/** Skill keys in catalog order, as a non-empty tuple (for the endorse tool's enum). */
export const SKILL_KEYS = SKILLS.map((s) => s.key) as [SkillKey, ...SkillKey[]];

export function isSkillKey(key: unknown): key is SkillKey {
  return typeof key === "string" && SKILLS.some((s) => s.key === key);
}

/** The entry for `key`, or the first entry. Never throws and never returns the raw key. */
function lookup<T extends { key: string }>(list: readonly [T, ...T[]], key: string): T {
  return list.find((item) => item.key === key) ?? list[0];
}

export function aliasText(key: string): string {
  return lookup<CatalogText>(ALIASES, key).text;
}

export function headlineText(key: string): string {
  return lookup<CatalogText>(HEADLINES, key).text;
}

export function bodyText(key: string): string {
  return lookup<CatalogText>(BODIES, key).text;
}

export function skillLabel(key: string): string {
  return lookup<CatalogSkill>(SKILLS, key).label;
}

/** The whole skill catalog, as the feed publishes it. */
export function skillCatalog(): { skill: string; label: string }[] {
  return SKILLS.map((s) => ({ skill: s.key, label: s.label }));
}
