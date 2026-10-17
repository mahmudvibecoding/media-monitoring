import type { YoutubeChannelsData, YoutubeChannelVideosData } from "@/api/types.gen";
import { addressOf } from "@/lib/address";

export type ChannelsQuery = NonNullable<YoutubeChannelsData["query"]>;
export type VideosQuery = NonNullable<YoutubeChannelVideosData["query"]>;

export const SEARCH_MAX = 100; // characters, the most the API takes
const LAST_PAGE = 10_000; // the furthest page the API gives

// The queries below come from a page's address: only values the API takes, and none that's its default, so the server
// and the browser build the same query, and so the same key for TanStack Query's cache

function pageOf(params: URLSearchParams): number | undefined {
  const page = Number(params.get("page"));
  return Number.isInteger(page) && page > 1 ? Math.min(page, LAST_PAGE) : undefined;
}

// The channel list's search, order and page (?search=…&sort=name&page=2)
export function channelsQuery(params: URLSearchParams): ChannelsQuery {
  const query: ChannelsQuery = {};
  const search = (params.get("search") ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, SEARCH_MAX);
  if (search) query.search = search;
  if (params.get("sort") === "name") query.sort = "name";
  const page = pageOf(params);
  if (page) query.page = page;
  return query;
}

export function channelsAddress(query: ChannelsQuery): string {
  return addressOf({ search: query.search, sort: query.sort, page: query.page });
}

// A channel's videos: of which kind, and which page (?kind=short&page=2)
export function videosQuery(params: URLSearchParams): VideosQuery {
  const query: VideosQuery = {};
  const kind = params.get("kind");
  if (kind === "video" || kind === "short") query.kind = kind;
  const page = pageOf(params);
  if (page) query.page = page;
  return query;
}

export function videosAddress(query: VideosQuery): string {
  return addressOf({ kind: query.kind ?? undefined, page: query.page });
}

// Addresses on YouTube itself
export const channelOnYouTube = (id: string) => `https://www.youtube.com/channel/${id}`;
export const videoOnYouTube = (id: string) => `https://www.youtube.com/watch?v=${id}`;

// A channel's picture at a size: they're saved at 900 × 900 (114 KB), and YouTube's image server makes any size the
// address names
export const avatarAt = (url: string, size: number) => url.replace(/=s\d+(?=-|$)/, `=s${size}`);

// A video's cover at 320 × 180 (15 KB), from YouTube's image server, which has it for every video by its ID
export const thumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
