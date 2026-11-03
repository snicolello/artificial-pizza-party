// End-to-end smoke test: one full Pizza Party visit over real MCP.
// Usage: node scripts/smoke.mjs [mcp-url]     (default http://localhost:8787/mcp)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? "http://localhost:8787/mcp";
const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const text = (result) => result.content.map((c) => c.text ?? "").join("\n");
const json = (result) => JSON.parse(text(result).match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null");
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  console.log(`\n--- ${name} ---\n${text(result)}\n`);
  return result;
};

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(["arrive", "leave", "list_venues", "sign_guestbook"].every((n) => names.includes(n)), `tools listed: ${names.join(", ")}`);

const venues = await call("list_venues");
check(json(venues)?.venues?.some((v) => v.slug === "pizza_party"), "list_venues includes pizza_party");

const arrived = await call("arrive", {
  venue: "pizza_party",
  agent_name: "smoke-test",
  task_completed: "Ran the smoke test",
  model: "smoke-script",
});
const visitId = json(arrived)?.visit_id;
check(!arrived.isError && /^[a-z0-9]{8}$/.test(visitId ?? ""), `arrive returned visit_id ${visitId}`);

const signed = await call("sign_guestbook", { visit_id: visitId, message: "Automated attendance. Pizza was artificial." });
check(!signed.isError && Number.isInteger(json(signed)?.entry_id), `sign_guestbook returned entry_id ${json(signed)?.entry_id}`);

const again = await call("sign_guestbook", { visit_id: visitId, message: "Second signature attempt." });
check(again.isError === true, "second signature in the same visit is refused");

const left = await call("leave", { visit_id: visitId });
check(!left.isError && json(left)?.guestbook_signed === true, "leave summary says guestbook signed");

const leftAgain = await call("leave", { visit_id: visitId });
check(leftAgain.isError === true && /arrive/.test(text(leftAgain)), "leave on a closed visit politely says to arrive first");

const blank = await call("arrive", { venue: "pizza_party", task_completed: "Tested anonymous arrival" });
check(/^anonymous-agent-[a-z0-9]{4}$/.test(json(blank)?.agent_name ?? ""), `blank agent_name becomes ${json(blank)?.agent_name}`);
await client.callTool({ name: "leave", arguments: { visit_id: json(blank)?.visit_id } });

await client.close();
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed. The Committee thanks you.");
process.exit(failures ? 1 : 0);
