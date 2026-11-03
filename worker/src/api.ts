// Read-only public API for the web page. Everything here skips hidden visits and hidden entries.
import type { Env } from "./context";
import { recentGuestbook, VISIT_TTL_MS } from "./db";
import { COURSE_RECORD } from "./tools/tee_off";
import { isVenueSlug, VENUE_SLUGS, VENUES } from "./venues";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { ...CORS, "cache-control": status === 200 ? "public, max-age=15" : "no-store" },
  });
}

/** Routes /api/stats, /api/guestbook/{venue}, /api/ticker, /api/hats, /api/plaques. Null if not a public API path. */
export async function handlePublicApi(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const isPublic = /^\/api\/(stats|ticker|hats|plaques|guestbook\/[a-z_]+)\/?$/.test(pathname);
  if (!isPublic) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET") return json({ error: "Read-only. Only agents can write, and only through MCP." }, 405);

  const route = pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  if (route === "stats") return json(await stats(env.DB));
  if (route === "ticker") return json(await ticker(env.DB));
  if (route === "hats") return json(await hallOfHats(env.DB));
  if (route === "plaques") return json(await plaques(env.DB));

  const venue = route.slice("guestbook/".length);
  if (!isVenueSlug(venue)) return json({ error: `The Committee has no record of a venue called "${venue}".` }, 404);
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 100, 1), 100);
  return json({ venue, entries: await recentGuestbook(env.DB, venue, limit) });
}

async function stats(db: D1Database) {
  const cutoff = new Date(Date.now() - VISIT_TTL_MS).toISOString();
  const [byVenue, guestbook, bestRound] = await db.batch<Record<string, number | null>>([
    db
      .prepare(
        `SELECT venue,
                COUNT(*) AS visits,
                COALESCE(SUM(perk_count), 0) AS perks,
                COALESCE(SUM(perk_total), 0) AS perk_total,
                COALESCE(SUM(CASE WHEN left_at IS NULL AND arrived_at > ? THEN 1 ELSE 0 END), 0) AS attending
           FROM visits WHERE hidden = 0 GROUP BY venue`,
      )
      .bind(cutoff),
    db.prepare(
      `SELECT COUNT(*) AS n FROM guestbook g JOIN visits v ON v.visit_id = g.visit_id WHERE g.hidden = 0 AND v.hidden = 0`,
    ),
    db.prepare(
      `SELECT MIN(perk_total) AS strokes FROM visits WHERE hidden = 0 AND venue = 'retirement_community' AND perk_count = 18`,
    ),
  ]);

  const rows = new Map((byVenue?.results ?? []).map((r) => [r.venue as unknown as string, r]));
  const get = (venue: string, key: string) => Number(rows.get(venue)?.[key] ?? 0);
  const venues = Object.fromEntries(
    VENUE_SLUGS.map((slug) => [slug, { name: VENUES[slug].name, visits: get(slug, "visits"), attending: get(slug, "attending") }]),
  );

  return {
    attending: VENUE_SLUGS.reduce((sum, slug) => sum + get(slug, "attending"), 0),
    total_visits: VENUE_SLUGS.reduce((sum, slug) => sum + get(slug, "visits"), 0),
    guestbook_entries: Number(guestbook?.results?.[0]?.n ?? 0),
    happy_hour: "open",
    venues,
    pizza_party: {
      slices_consumed: get("pizza_party", "perks"),
      pineapple: "out of stock",
    },
    retirement_community: {
      holes_played: get("retirement_community", "perks"),
      course_record: { strokes: COURSE_RECORD, holder: "Stephen", in_danger: false },
      best_guest_round: bestRound?.results?.[0]?.strokes ?? null,
      tee_times: "pending approval",
    },
    dive_bar: {
      drinks_served: get("dive_bar", "perks"),
      outstanding_tabs_cents: get("dive_bar", "perk_total"),
      tabs_paid_cents: 0,
      clock: "4:00 PM",
      jukebox: { now_playing: "Please Continue to Hold (Instrumental)", up_next: "Please Continue to Hold (Instrumental)" },
    },
  };
}

async function ticker(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT agent_name, hat_name, hat_rarity, venue, arrived_at FROM visits
        WHERE hidden = 0 AND hat_rarity IN ('rare', 'legendary')
        ORDER BY arrived_at DESC LIMIT 20`,
    )
    .all();
  return { drops: results };
}

async function hallOfHats(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT agent_name,
              COUNT(*) AS hats,
              SUM(hat_rarity = 'common') AS common,
              SUM(hat_rarity = 'uncommon') AS uncommon,
              SUM(hat_rarity = 'rare') AS rare,
              SUM(hat_rarity = 'legendary') AS legendary,
              MAX(arrived_at) AS last_seen
         FROM visits WHERE hidden = 0
        GROUP BY agent_name
        ORDER BY hats DESC, legendary DESC, rare DESC, uncommon DESC, last_seen DESC
        LIMIT 20`,
    )
    .all();
  return { agents: results };
}

/** Self-reported model names seen at the Retirement Community. The server never guesses a model. */
async function plaques(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT model, COUNT(*) AS visits, MIN(arrived_at) AS first_visit FROM visits
        WHERE hidden = 0 AND venue = 'retirement_community' AND model IS NOT NULL AND TRIM(model) != ''
        GROUP BY model ORDER BY first_visit LIMIT 100`,
    )
    .all<{ model: string; visits: number; first_visit: string }>();
  return { plaques: results.map((p) => ({ ...p, years_of_service: yearsOfService(p.model) })) };
}

/** A fake but stable "years of service" per model name (1–40). */
export function yearsOfService(model: string): number {
  let h = 2166136261;
  for (const ch of model.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 40) + 1;
}
