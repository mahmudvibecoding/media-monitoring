import type { YoutubeChannelsData, YoutubeChannelVideosData } from "@/api/types.gen";
import { addressOf, pageOf, searchOf } from "@/lib/address";

export type ChannelsQuery = NonNullable<YoutubeChannelsData["query"]>;
export type VideosQuery = NonNullable<YoutubeChannelVideosData["query"]>;

// The queries below come from a page's address: only values the API takes, and none that's its default, so the server
// and the browser build the same query, and so the same key for TanStack Query's cache

// The channel list's search, order and page (?search=…&sort=name&page=2)
export function channelsQuery(params: URLSearchParams): ChannelsQuery {
  const query: ChannelsQuery = {};
  const search = searchOf(params);
  if (search) query.search = search;
  if (params.get("sort") === "name") query.sort = "name";
  const page = pageOf(params);
  if (page) query.page = page;
  return query;
}

export function channelsAddress(query: ChannelsQuery): string {
  return addressOf({ search: query.search, sort: query.sort, page: query.page });
}

// A channel's videos: of which kind (?kind=short); more of them load as the list is scrolled, so no page
export function videosQuery(params: URLSearchParams): VideosQuery {
  const kind = params.get("kind");
  return kind === "video" || kind === "short" ? { kind } : {};
}

export function videosAddress(query: VideosQuery): string {
  return addressOf({ kind: query.kind ?? undefined });
}

// Addresses on YouTube itself
export const channelOnYouTube = (id: string) => `https://www.youtube.com/channel/${id}`;
export const videoOnYouTube = (id: string) => `https://www.youtube.com/watch?v=${id}`;

// A channel's picture at a size: they're saved at 900 × 900 (114 KB), and YouTube's image server makes any size the
// address names
export const avatarAt = (url: string, size: number) => url.replace(/=s\d+(?=-|$)/, `=s${size}`);

// A video's cover from YouTube's image server, which has it for every video by its ID: 320 × 180 (15 KB), 480 × 360
// with black bars above and below (23 KB), which a 16:9 frame cuts off, or 1280 × 720 for the biggest (not every
// video has that one: YouTube answers 404 for some)
export const thumbnail = (id: string, size: "mq" | "hq" | "maxres" = "mq") =>
  `https://i.ytimg.com/vi/${id}/${size}default.jpg`;
