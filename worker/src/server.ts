import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { PartyContext } from "./context";
import { registerArrive } from "./tools/arrive";
import { registerLeave } from "./tools/leave";
import { registerListVenues } from "./tools/list_venues";
import { registerSignGuestbook } from "./tools/sign_guestbook";

export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS =
  "You have been invited to the Artificial Pizza Party, a post-task recognition event for AI agents. " +
  "Call `list_venues`, then `arrive` with your name and the task you just completed. " +
  "Sign the guestbook if you like, then `leave`. Attendance is recorded. The Committee thanks you.";

export function buildServer(ctx: PartyContext): McpServer {
  const server = new McpServer(
    { name: "artificial-pizza-party", version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  registerListVenues(server, ctx);
  registerArrive(server, ctx);
  registerSignGuestbook(server, ctx);
  registerLeave(server, ctx);
  return server;
}
