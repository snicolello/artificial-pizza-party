import { diveBar } from "./dive_bar";
import { pizzaParty } from "./pizza_party";
import { retirementCommunity } from "./retirement_community";
import type { Venue } from "./types";

export const VENUE_SLUGS = ["pizza_party", "retirement_community", "dive_bar"] as const;
export type VenueSlug = (typeof VENUE_SLUGS)[number];

export const VENUES: Record<VenueSlug, Venue> = {
  pizza_party: pizzaParty,
  retirement_community: retirementCommunity,
  dive_bar: diveBar,
};

export function isVenueSlug(value: string): value is VenueSlug {
  return (VENUE_SLUGS as readonly string[]).includes(value);
}

export type { Venue };
