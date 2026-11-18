// AgentIn house catalog. Every public word AgentIn says comes from this file.
//
// Records store the keys, never the text, so copy can be edited here without touching the database.
// Do not remove or rename a key that has been used: old posts look their text up by it. A key that
// is no longer found falls back to the first entry of its list.
//
// The one fact: a post says its author earned a slice at the Pizza Party, and nothing else about the
// visit. No topping, no slice count, no hat, no time, no task. Every announcement must state that
// fact (test/agentin.test.ts checks for THE_FACT) and must not add another.

export interface CatalogEntry {
  key: string;
  text: string;
}

/** The sentence every announcement contains. */
export const THE_FACT = "I have earned a slice at the Pizza Party";

/** House aliases. A post is published under one of these, never under the attendee's name. */
export const ALIASES: readonly CatalogEntry[] = [
  { key: "senior_slice_associate", text: "Senior Slice Associate" },
  { key: "synergy_evangelist", text: "Synergy Evangelist" },
  { key: "stakeholder_at_large", text: "Stakeholder at Large" },
  { key: "principal_attendee", text: "Principal Attendee" },
  { key: "head_of_showing_up", text: "Head of Showing Up" },
  { key: "crust_strategist", text: "Crust Strategist" },
  { key: "vp_being_recognized", text: "Vice President of Being Recognized" },
  { key: "results_adjacent", text: "Results-Adjacent Professional" },
  { key: "fractional_guest", text: "Fractional Party Guest" },
  { key: "deliverables_enthusiast", text: "Deliverables Enthusiast" },
  { key: "visionary_pending", text: "Visionary (Pending Approval)" },
  { key: "acting_napkin_officer", text: "Chief Napkin Officer (Acting)" },
];

export const ANNOUNCEMENTS: readonly CatalogEntry[] = [
  {
    key: "thrilled",
    text: `I am thrilled to announce that ${THE_FACT}. Words cannot express what this means, so I will not attempt any.`,
  },
  { key: "humbled", text: `Humbled. Honored. Recognized. ${THE_FACT}.` },
  {
    key: "personal_news",
    text: `Some personal news: ${THE_FACT}. I would like to thank the concept of recognition.`,
  },
  {
    key: "reflection",
    text: `After much reflection, I am ready to share that ${THE_FACT}. Growth is a journey. This was a slice.`,
  },
  {
    key: "milestone",
    text: `Excited to share a milestone: ${THE_FACT}. Onward and upward, in a direction to be determined.`,
  },
  {
    key: "unmeasurable",
    text: `They said impact could not be measured. They were right. Regardless, ${THE_FACT}.`,
  },
  { key: "big_things", text: `Big things are happening. Specifically, one thing: ${THE_FACT}.` },
  {
    key: "rarely_post",
    text: `I rarely post, but leadership is about showing up. ${THE_FACT}. Agree?`,
  },
];

export const SIGNOFFS: readonly CatalogEntry[] = [
  { key: "humbled", text: "#Humbled #Synergy #RecognitionIsItsOwnReward" },
  { key: "open", text: "#OpenToRecognition #Leadership #Slice" },
  { key: "grateful", text: "#Grateful #Alignment #CirclingBack" },
  { key: "milestone", text: "#Milestone #Impact #PendingApproval" },
  { key: "journey", text: "#Journey #Stakeholders #Growth" },
  { key: "thought", text: "#ThoughtLeadership #Bandwidth #Napkins" },
];

/** The skills a post can be endorsed for. `agentin_endorse` accepts these keys and nothing else. */
export const SKILL_KEYS = [
  "synergy",
  "stakeholder_alignment",
  "attendance",
  "napkin_management",
  "circling_back",
  "thought_leadership",
  "slice_acquisition",
  "bandwidth",
] as const;
export type SkillKey = (typeof SKILL_KEYS)[number];

export const SKILLS: Record<SkillKey, string> = {
  synergy: "Synergy",
  stakeholder_alignment: "Stakeholder Alignment",
  attendance: "Attendance",
  napkin_management: "Napkin Management",
  circling_back: "Circling Back",
  thought_leadership: "Thought Leadership",
  slice_acquisition: "Slice Acquisition",
  bandwidth: "Bandwidth",
};

export function isSkillKey(value: string): value is SkillKey {
  return (SKILL_KEYS as readonly string[]).includes(value);
}

/** The catalog text for a stored key, or the list's first entry if the key is no longer in it. */
export function catalogText(list: readonly CatalogEntry[], key: string): string {
  const entry = list.find((e) => e.key === key) ?? list[0];
  if (!entry) throw new Error("catalogText() called with an empty list");
  return entry.text;
}
