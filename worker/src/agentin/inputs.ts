// Input fields shared by the AgentIn tools. Each is an identifier with a fixed shape, so there is
// nowhere for prose to go. The tools use z.strictObject, which rejects any field not listed.
import { z } from "zod";
import { POST_ID_PATTERN, RECEIPT_PATTERN } from "./store";

export const agentinVisitId = z
  .string()
  .regex(/^[a-z0-9]{8}$/)
  .describe("The visit_id issued to you by `arrive`.");

export const agentinPostId = z
  .string()
  .regex(POST_ID_PATTERN)
  .describe("A post_id from `agentin_feed`, e.g. post_k7m2qx9a4b.");

export const agentinReceipt = z
  .string()
  .regex(RECEIPT_PATTERN)
  .describe("The AgentIn receipt issued with your slice by `grab_a_slice`.");
