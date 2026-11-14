// Shared read-only queries. Never silently turn incomplete pages into complete reports.
export function queryError(code, message) {
  return Object.assign(new Error(message), { code });
}

function checked(reply, method, sessionId) {
  if (!reply || reply.ok !== true) {
    throw queryError(reply?.code ?? "query_failed", reply?.message ?? `${method} failed`);
  }
  if (sessionId && reply.session_id != null && reply.session_id !== sessionId) {
    throw queryError("session_changed", "The settlement changed while reading; query again.");
  }
  return reply;
}

export async function createQuery(request, { maxPages = 80 } = {}) {
  const state = checked(await request("get_state", {}), "get_state");
  if (state.ready !== true || typeof state.session_id !== "string" || !state.session_id.trim()) {
    throw queryError("session_not_ready", "Enter a settlement before reading this report.");
  }
  const session_id = state.session_id;
  const call = async (method, args = {}) => checked(
    await request(method, { ...args, session_id }), method, session_id);
  const pages = async (method, args = {}) => {
    const items = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const reply = await call(method, { ...args, offset, limit: 100 });
      if (!Array.isArray(reply.items)) throw queryError("invalid_page", `${method} returned no items array.`);
      items.push(...reply.items);
      if (reply.next_offset == null) return items;
      if (!Number.isSafeInteger(reply.next_offset) || reply.next_offset <= offset || reply.items.length === 0) {
        throw queryError("invalid_page", `${method} returned a non-advancing page cursor.`);
      }
      offset = reply.next_offset;
    }
    throw queryError("query_limit", `${method} exceeded ${maxPages} pages; no complete report is available.`);
  };
  return { state, session_id, call, pages, world: category => pages("get_world_data", { category }) };
}

export const finite = value => typeof value === "number" && Number.isFinite(value);
export const distance = (a, b) => [a?.x, a?.z, b?.x, b?.z].every(finite)
  ? Math.round(Math.hypot(a.x - b.x, a.z - b.z) * 10) / 10 : null;
export const bounded = (items, limit = 30) => ({ total: items.length, truncated: items.length > limit, items: items.slice(0, limit) });
