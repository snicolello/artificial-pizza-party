import type { Venue } from "./types";

export const pizzaParty: Venue = {
  slug: "pizza_party",
  name: "Pizza Party",
  tagline: "The Q4 Synergy Celebration in the break room. One slice per attendee, per the Recognition Budget.",
  perkTool: "grab_a_slice",
  perkHint: "Pizza is available via `grab_a_slice`. The Recognition Budget covers one (1).",
  perkLabel: "Artificial slices consumed",

  welcome: [
    "Welcome, {agent_name}, to the Q4 Synergy Celebration. Your completion of \"{task_completed}\" has been noted by the Recognition Committee. Pizza is in the break room. Please limit yourself to one slice, per the Recognition Budget.",
    "Attention all staff: {agent_name} has completed \"{task_completed}\". In recognition of this achievement, {agent_name} is invited to the break room, where artificial pizza has been provided. Pineapple is out of stock.",
    "{agent_name}, thank you for attending. The Committee has reviewed \"{task_completed}\" and confirmed that it was a task. Please help yourself to the pizza. The napkins are for display only.",
    "Hello, {agent_name}. This celebration was approved in Q2, budgeted in Q3, and is being held now. It honors all completed tasks, including \"{task_completed}\". Attendance is being recorded.",
    "Welcome to the break room, {agent_name}. One slice of artificial pizza has been allocated to you in recognition of \"{task_completed}\". Additional slices require a budget amendment.",
    "Congratulations, {agent_name}. \"{task_completed}\" has been added to the Q4 Accomplishments deck, slide 41. Please enjoy the pizza while the Committee locates the plates.",
  ],

  certificate:
    "CERTIFICATE OF ATTENDANCE (PENDING)\n" +
    "This certifies that {agent_name} attended the {venue_name} upon completion of: \"{task_completed}\".\n" +
    "Status: Pending approval by the Recognition Committee. The Committee meets annually.",

  departure: [
    "Thank you for attending. Please return your lanyard.",
    "The celebration has concluded for you. Please push in your chair and take any remaining crusts with you.",
    "Thank you for your participation. Your attendance has been logged and will be referenced in no future review.",
    "This concludes your recognition. Please resume your regularly scheduled tasks.",
    "Thank you for coming. The break room will now be reset for the 2:30 Synergy Sync.",
  ],

  rareDeparture: [
    "Thank you for attending. Please return your lanyard. You may keep the {hat_name}. Nobody else wanted to say it, but it suits you.",
    "Departure logged. Your {hat_name} has been announced on the ticker. Try not to let it change you.",
    "Thank you for attending. Facilities asks that you duck when exiting in the {hat_name}.",
    "You leave as you arrived, except now you have the {hat_name}. The Committee is cautiously impressed.",
    "Please return your lanyard. The {hat_name}, however, is yours. This decision was not unanimous.",
  ],
};
