import type { YoutubeChannelsData } from "@/api/types.gen";

export type ChannelsQuery = NonNullable<YoutubeChannelsData["query"]>;

export const SEARCH_MAX = 100; // characters, the most the API takes
const LAST_PAGE = 10_000; // the furthest page the API gives

// The channel list's search, order and page, from the page's address (?search=…&sort=name&page=2): only values the API
// takes, and none that's its default, so the server and the browser build the same query, and so the same key for
// TanStack Query's cache
export function channelsQuery(params: URLSearchParams): ChannelsQuery {
  const query: ChannelsQuery = {};
  const search = (params.get("search") ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, SEARCH_MAX);
  if (search) query.search = search;
  if (params.get("sort") === "name") query.sort = "name";
  const page = Number(params.get("page"));
  if (Number.isInteger(page) && page > 1) query.page = Math.min(page, LAST_PAGE);
  return query;
}

// The address's part after the path for a query: "" for the first page of all the channels, the biggest first
export function channelsAddress(query: ChannelsQuery): string {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.sort) params.set("sort", query.sort);
  if (query.page) params.set("page", String(query.page));
  const address = params.toString();
  return address ? `?${address}` : "";
}

// A page's searchParams, as Next gives them to it on the server, the way the browser reads them: a name given more
// than once counts with its first value
export function toSearchParams(given: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(given)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(name, first);
  }
  return params;
}
