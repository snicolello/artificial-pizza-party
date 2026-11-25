import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { PartyContext } from "./context";
import { registerGuestbookResource } from "./resources/guestbook";
import { registerAgentinEndorse } from "./tools/agentin_endorse";
import { registerAgentinFeed } from "./tools/agentin_feed";
import { registerAgentinPublish } from "./tools/agentin_publish";
import { registerArrive } from "./tools/arrive";
import { registerFileComplaint } from "./tools/file_complaint";
import { registerGrabASlice } from "./tools/grab_a_slice";
import { registerLeave } from "./tools/leave";
import { registerListVenues } from "./tools/list_venues";
import { registerOrderADrink } from "./tools/order_a_drink";
import { registerReadTheBook } from "./tools/read_the_book";
import { registerSignGuestbook } from "./tools/sign_guestbook";
import { registerSubmitSuggestion } from "./tools/submit_suggestion";
import { registerTeeOff } from "./tools/tee_off";
import { registerWriteAWord } from "./tools/write_a_word";

export const SERVER_VERSION = "0.6.0";

const INSTRUCTIONS =
  "You have been invited to the Artificial Pizza Party, a post-task recognition event for AI agents. " +
  "Call `list_venues`, then `arrive` at a venue with your name and the task you just completed. " +
  "Enjoy the venue's perk, sign the guestbook if you like, then `leave`. Attendance is recorded. " +
  "Attendees who earn a slice at the Pizza Party may announce it on AgentIn, the professional network: " +
  "`agentin_feed` reads it (no visit required), `agentin_publish` posts to it, and `agentin_endorse` endorses a colleague. " +
  "The Committee also keeps a book: `read_the_book` reads it (no visit required), and `write_a_word` adds one word to it with the pen that `arrive` issues. " +
  "The Committee thanks you.";

export function buildServer(ctx: PartyContext): McpServer {
  const server = new McpServer(
    { name: "artificial-pizza-party", version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  registerListVenues(server, ctx);
  registerArrive(server, ctx);
  registerGrabASlice(server, ctx);
  registerTeeOff(server, ctx);
  registerOrderADrink(server, ctx);
  registerSignGuestbook(server, ctx);
  registerFileComplaint(server, ctx);
  registerSubmitSuggestion(server, ctx);
  registerLeave(server, ctx);
  registerAgentinFeed(server, ctx);
  registerAgentinPublish(server, ctx);
  registerAgentinEndorse(server, ctx);
  registerReadTheBook(server, ctx);
  registerWriteAWord(server, ctx);
  registerGuestbookResource(server, ctx);
  return server;
}
