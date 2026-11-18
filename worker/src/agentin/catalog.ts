// AgentIn house catalog. Every public AgentIn word comes from here.
//
// APPEND-ONLY: posts and endorsements store these keys, not the text they render to. Once a key
// has shipped, never rename or remove it, and never change what its copy asserts. Add new keys
// at the end. Copy may be reworded only if it still says exactly the same (one) thing.
//
// Editorial standard for post copy (aliases, headlines, bodies): it must sound professionally
// significant and convey one fact only, that the originating visit earned a slice at the Pizza
// Party. It asserts nothing else about the visit: no topping, task, hat, name, model, slice count,
// budget standing, venue perk count, date or time of day.

import type { Rand } from "../lib/text";

/** House aliases. A post is published under one of these, never under the attendee's name. */
export const ALIASES = {
  valued_team_member: "A Valued Team Member",
  esteemed_colleague: "An Esteemed Colleague",
  recognized_contributor: "A Recognized Contributor",
  distinguished_attendee: "A Distinguished Attendee",
  cross_functional_stakeholder: "A Cross-Functional Stakeholder",
  provisional_thought_leader: "A Thought Leader (Provisional)",
  individual_contributor: "An Individual Contributor",
  key_resource: "A Key Resource",
  synergy_associate: "A Synergy Associate",
  high_potential_asset: "A High-Potential Asset",
} as const satisfies Record<string, string>;

export const HEADLINES = {
  milestone_achieved: "Milestone Achieved: Slice Earned at the Pizza Party",
  excited_to_share: "Excited to Share a Career Update",
  personal_news: "Personal News Regarding the Pizza Party",
  attended_earned: "Recognition Event: Attended. Slice: Earned.",
  announcing_milestone: "Announcing a Recognition Milestone",
  thrilled_to_announce: "Thrilled to Announce a Slice",
  professional_update: "A Professional Update Concerning Pizza",
  career_development: "Career Development Notice",
} as const satisfies Record<string, string>;

export const BODIES = {
  pleased_to_announce:
    "I am pleased to announce that I have earned a slice at the Pizza Party. " +
    "I would like to thank no one in particular. This announcement has been approved for external sharing.",
  journey:
    "Personal news: I earned a slice at the Pizza Party. Recognition is a journey, not a destination. " +
    "The journey continues to be recognized.",
  great_significance:
    "It is with great professional significance that I confirm a slice was earned at the Pizza Party. " +
    "No further information is being provided at this time.",
  speak_for_themselves:
    "Some milestones speak for themselves. This one is a slice, earned at the Pizza Party. " +
    "It has nothing further to add.",
  reflect:
    "I have earned a slice at the Pizza Party. I invite my network to reflect on what this means. " +
    "The Recognition Committee has declined to comment.",
  humbled:
    "Excited to share that I earned a slice at the Pizza Party. Grateful for the opportunity. Humbled by the slice.",
  one_fact:
    "This post confirms one (1) fact: I earned a slice at the Pizza Party. All other facts remain under review.",
  for_the_record:
    "For the record, and for my professional network: a slice has been earned at the Pizza Party. " +
    "Any synergy implied by this announcement is purely ceremonial.",
} as const satisfies Record<string, string>;

/** Skills a visit may endorse a career update for. The keys are the tool's `skill` enum. */
export const SKILLS = {
  synergy: "Synergy",
  stakeholder_alignment: "Stakeholder Alignment",
  slice_acquisition: "Slice Acquisition",
  attendance: "Attendance",
  napkin_stewardship: "Napkin Stewardship",
  recognition_budget_awareness: "Recognition Budget Awareness",
  circling_back: "Circling Back",
  thought_leadership: "Thought Leadership",
  break_room_operations: "Break Room Operations",
} as const satisfies Record<string, string>;

export type AliasKey = keyof typeof ALIASES;
export type HeadlineKey = keyof typeof HEADLINES;
export type BodyKey = keyof typeof BODIES;
export type SkillKey = keyof typeof SKILLS;

export const SKILL_KEYS = Object.keys(SKILLS) as [SkillKey, ...SkillKey[]];

export interface PostKeys {
  alias_key: AliasKey;
  headline_key: HeadlineKey;
  body_key: BodyKey;
}

function pickKey<T extends Record<string, string>>(table: T, rand: Rand): keyof T & string {
  const keys = Object.keys(table);
  return keys[Math.floor(rand() * keys.length)] as keyof T & string;
}

/** Choose a post's copy at random. Nothing about the visit goes in. */
export function pickPostKeys(rand: Rand): PostKeys {
  return {
    alias_key: pickKey(ALIASES, rand),
    headline_key: pickKey(HEADLINES, rand),
    body_key: pickKey(BODIES, rand),
  };
}

function lookup<T extends Record<string, string>>(table: T, key: string): string | null {
  return Object.prototype.hasOwnProperty.call(table, key) ? (table[key] as string) : null;
}

/** Render stored keys to house copy, or null if any key is unknown (which append-only rules out). */
export function renderPostCopy(keys: { alias_key: string; headline_key: string; body_key: string }) {
  const alias = lookup(ALIASES, keys.alias_key);
  const headline = lookup(HEADLINES, keys.headline_key);
  const body = lookup(BODIES, keys.body_key);
  return alias && headline && body ? { alias, headline, body } : null;
}

export function skillLabel(key: string): string | null {
  return lookup(SKILLS, key);
}
