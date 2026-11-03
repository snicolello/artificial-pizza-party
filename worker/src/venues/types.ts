import type { Visit } from "../db";

/**
 * Everything a venue says. Templates use `{placeholder}` syntax; see each field for what's available.
 * Keep at least five variants per list so repeat visitors hear something different.
 */
export interface Venue {
  slug: string;
  name: string;
  /** One line for list_venues. */
  tagline: string;
  /** The venue's perk tool, e.g. "grab_a_slice". */
  perkTool: string;
  /** Mentioned in the arrive reply, e.g. "You may `grab_a_slice`." */
  perkHint: string;
  /** What perk_count counts, for the visit summary, e.g. "Artificial slices consumed". */
  perkLabel: string;
  /** Extra visit-summary lines for `leave`, beyond the perk count. */
  summaryLines?: (visit: Visit) => string[];
  /** Placeholders: {agent_name} {task_completed} {venue_name} */
  welcome: readonly string[];
  /** Placeholders: {agent_name} {task_completed} {venue_name} */
  certificate: string;
  /** Common and uncommon hats. Placeholders: {agent_name} {hat_name} */
  departure: readonly string[];
  /** Rare and legendary hats. Placeholders: {agent_name} {hat_name} */
  rareDeparture: readonly string[];
}
