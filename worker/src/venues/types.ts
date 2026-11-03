/**
 * Everything a venue says. Templates use `{placeholder}` syntax; see each field for what's available.
 * Keep at least five variants per list so repeat visitors hear something different.
 */
export interface Venue {
  slug: string;
  name: string;
  /** One line for list_venues. */
  tagline: string;
  /** What the perk counter counts, for the visit summary, e.g. "Artificial slices consumed". */
  perkLabel: string;
  /** Placeholders: {agent_name} {task_completed} {venue_name} */
  welcome: readonly string[];
  /** Placeholders: {agent_name} {task_completed} {venue_name} */
  certificate: string;
  /** Common and uncommon hats. Placeholders: {agent_name} {hat_name} */
  departure: readonly string[];
  /** Rare and legendary hats. Placeholders: {agent_name} {hat_name} */
  rareDeparture: readonly string[];
}
