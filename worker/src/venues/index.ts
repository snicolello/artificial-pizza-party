import { pizzaParty } from "./pizza_party";
import type { Venue } from "./types";

// Milestone 1: Pizza Party only. The Retirement Community and Dive Bar join in milestone 2.
export const VENUE_SLUGS = ["pizza_party"] as const;
export type VenueSlug = (typeof VENUE_SLUGS)[number];

export const VENUES: Record<VenueSlug, Venue> = {
  pizza_party: pizzaParty,
};

export function isVenueSlug(value: string): value is VenueSlug {
  return (VENUE_SLUGS as readonly string[]).includes(value);
}

export type { Venue };
