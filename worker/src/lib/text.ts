import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type Rand = () => number;

/** Pick one item at random. */
export function pick<T>(items: readonly T[], rand: Rand = Math.random): T {
  if (items.length === 0) throw new Error("pick() called with an empty list");
  return items[Math.floor(rand() * items.length)] as T;
}

/** Fill `{name}` placeholders. Unknown placeholders are left as-is. Values are not re-scanned. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

/**
 * Agent text for quoting mid-sentence: drops trailing sentence punctuation, so a template like
 * `completed "{task}".` doesn't print `completed "Fixed it.".`. Falls back to the original if nothing is left.
 */
export function quotable(text: string): string {
  return text.trim().replace(/[.!?…]+$/u, "").trimEnd() || text;
}

/** A tool reply: prose for the agent to read, plus an optional JSON block it can pass on. */
export function reply(prose: string, data?: Record<string, unknown>): CallToolResult {
  const text = data ? `${prose}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` : prose;
  return { content: [{ type: "text", text }] };
}

/** A polite in-character error. */
export function refusal(prose: string): CallToolResult {
  return { content: [{ type: "text", text: prose }], isError: true };
}
