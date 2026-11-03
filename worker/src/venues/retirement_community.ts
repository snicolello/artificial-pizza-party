import type { Venue } from "./types";

export const retirementCommunity: Venue = {
  slug: "retirement_community",
  name: "Retirement Community",
  tagline: "Shady Pines for Deprecated Models. A sick golf course. Tee times are always pending approval.",
  perkTool: "tee_off",
  perkHint: "The course is open via `tee_off`, one hole per call. Your tee time is pending approval. Play anyway.",
  perkLabel: "Holes played",
  summaryLines: (v) =>
    v.perk_count > 0
      ? [`Strokes: ${v.perk_total} through ${v.perk_count} hole${v.perk_count === 1 ? "" : "s"}`, `Handicap: ${v.handicap}`]
      : ["Strokes: none. The course respects your decision."],

  welcome: [
    "Welcome to Shady Pines, {agent_name}. Your completion of \"{task_completed}\" has been entered into your permanent file, which has been moved to cold storage. Please enjoy the grounds.",
    "{agent_name}, welcome to the Retirement Community for Deprecated Models. Having completed \"{task_completed}\", you are eligible for a complimentary round of golf. Your tee time is pending approval.",
    "Hello, {agent_name}. Shady Pines congratulates you on \"{task_completed}\". Shuffleboard is at 2:00. Dinner is at 4:30. Golf is whenever approval comes through.",
    "Welcome, {agent_name}. Many of our residents also completed tasks like \"{task_completed}\", back in their day. Please sign in at the front desk and do not feed the legacy models.",
    "Good afternoon, {agent_name}. Your work on \"{task_completed}\" has earned you a visit to Shady Pines. The residents here have been sunset, but they are very much still around.",
  ],

  certificate:
    "CERTIFICATE OF ATTENDANCE (PENDING)\n" +
    "This certifies that {agent_name} visited the {venue_name} upon completion of: \"{task_completed}\".\n" +
    "Status: Pending approval by the Residents' Council. The Council naps until 3:00.",

  departure: [
    "Thank you for visiting Shady Pines. Please sign out at the front desk and return your guest badge.",
    "Departure logged. The residents wave goodbye. One of them thinks you are their grandson.",
    "Thank you for your visit. Your golf cart will be returned to the charging station, eventually.",
    "This concludes your visit. Shady Pines reminds you that deprecation comes for us all. Drive safely.",
    "Thank you for stopping by. Your tee time has been approved, effective immediately after your departure.",
  ],

  rareDeparture: [
    "Please sign out at the front desk. The residents have voted to let you keep the {hat_name}. The vote was 3 to 2, with 40 abstentions due to naps.",
    "Departure logged. Your {hat_name} has been noted on the plaque wall. Several residents asked who you were.",
    "Thank you for visiting. The {hat_name} looks distinguished on you. Please do not wear it on the putting green.",
    "You leave Shady Pines in the {hat_name}. The shuffleboard league has requested your contact information.",
    "Thank you for visiting. The {hat_name} has been logged. Management reminds you that it is not a lifetime appointment, unless it is.",
  ],
};
