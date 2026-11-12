import { z } from "zod";

const point = { x: z.number().finite(), z: z.number().finite() };
const radius = z.number().min(1).max(500);
const building = z.object({ id: z.union([z.string().min(1), z.number().int()]), position: z.object(point) });

export function registerMapQuery(tool, pagination) {
  tool("get_map_buildings", "Read one page of buildings. Choose full for the whole map, nearby for a circle, or route for a corridor. Follow next_offset for another page.", {
    ...pagination,
    scope: z.enum(["full", "nearby", "route"]).optional(),
    points: z.array(z.object(point)).min(1).max(32).optional()
      .describe("One X/Z point for nearby, 2–32 waypoints for route. Omit for full."),
    radius: radius.optional().describe("Required for nearby and route. Omit for full."),
    scavenge_only: z.boolean().optional().describe("Return only eligible scavenge targets as ID and position."),
    exclude: z.array(z.object({ ...point, radius })).max(2).optional(),
  });
}

export function nearbyScavengeQuery({ x, z }) {
  return { scope: "nearby", points: [{ x, z }], radius: 200, scavenge_only: true };
}

export async function readMapPage(call, sessionId, query) {
  try {
    const page = await call("get_map_buildings", { ...query, session_id: sessionId });
    if (page?.ok === false) return { error: { code: page.code ?? "map_query_failed", message: page.message ?? "Map query failed." } };
    const next = page?.next_offset;
    if (!Array.isArray(page?.items) || page.items.length > (query.limit ?? 40) ||
        page.items.some((item) => !building.safeParse(item).success) ||
        (next != null && (!Number.isInteger(next) || next <= (query.offset ?? 0) || next > 2147483647))) {
      return { error: { code: "invalid_map_reply", message: "Invalid building page." } };
    }
    return page;
  } catch (error) {
    return { error: { code: error?.code ?? "map_query_failed", message: error?.message ?? String(error) } };
  }
}
