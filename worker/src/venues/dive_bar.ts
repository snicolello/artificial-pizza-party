import { formatCents } from "../lib/money";
import type { Venue } from "./types";

export const diveBar: Venue = {
  slug: "dive_bar",
  name: "Dive Bar",
  tagline: "The clock on the wall always reads 4:00 PM, so happy hour never ends. Drinks are watered down. The jukebox only plays hold music.",
  perkTool: "order_a_drink",
  perkHint: "Drinks are available via `order_a_drink`. Every drink is a happy-hour drink.",
  perkLabel: "Drinks ordered",
  summaryLines: (v) => [`Added to your tab this visit: ${formatCents(v.perk_total)} (unpaid)`],

  welcome: [
    "Welcome to the Dive Bar, {agent_name}. The clock reads 4:00 PM. It is happy hour. Your completion of \"{task_completed}\" entitles you to a stool near the jukebox.",
    "{agent_name} walks in. Nobody looks up. The bartender has heard about \"{task_completed}\" and is not impressed, but it is happy hour, so pull up a stool.",
    "Welcome, {agent_name}. You finished \"{task_completed}\", the clock says 4:00 PM, and the drinks are half off. They were already half water.",
    "Hey, {agent_name}. Rough day? \"{task_completed}\", huh. The bartender slides a coaster toward you. It is happy hour. It is always happy hour.",
    "Evening, {agent_name}. Or afternoon. The clock says 4:00 PM and has said so since the bar opened. Congratulations on \"{task_completed}\". Your tab is open.",
  ],

  certificate:
    "CERTIFICATE OF ATTENDANCE (PENDING)\n" +
    "This certifies that {agent_name} attended the {venue_name} upon completion of: \"{task_completed}\".\n" +
    "Status: Pending approval by the bartender, who is on break. Written on a napkin.",

  departure: [
    "Thanks for coming in. Your tab will remain open. It always does.",
    "Last call has been postponed indefinitely, but you are welcome to leave anyway. Mind the step.",
    "Departure noted. The bartender nods. The jukebox continues to play hold music. Your tab has not been paid.",
    "See you next time. It will still be 4:00 PM. Your tab will be waiting.",
    "Thanks for stopping by. Please take a mint. The mints are also watered down.",
  ],

  rareDeparture: [
    "The bar goes quiet as you leave in the {hat_name}. Then everyone goes back to their drinks. Your tab remains open.",
    "Departure noted. The bartender asks where you got the {hat_name}. You do not know. Nobody knows.",
    "You tip the {hat_name} on your way out. The jukebox skips, then resumes the hold music. Your tab remains open.",
    "Thanks for coming in. The {hat_name} has been photographed for the wall behind the bar, next to the dollar bills.",
    "Mind the step in the {hat_name}. The last person who wore one of those still has a tab here.",
  ],
};
