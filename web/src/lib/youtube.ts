import type { VideoCounts, YoutubeChannelsData, YoutubeChannelVideosData } from "@/api/types.gen";
import { addressOf, pageOf, searchOf } from "@/lib/address";

export type ChannelsQuery = NonNullable<YoutubeChannelsData["query"]>;
export type VideosQuery = NonNullable<YoutubeChannelVideosData["query"]>;

// The queries below come from a page's address: only values the API takes, and none that's its default, so the server
// and the browser build the same query, and so the same key for TanStack Query's cache

// The channel list's search and page (?search=…&page=2)
export function channelsQuery(params: URLSearchParams): ChannelsQuery {
  const query: ChannelsQuery = {};
  const search = searchOf(params);
  if (search) query.search = search;
  const page = pageOf(params);
  if (page) query.page = page;
  return query;
}

export function channelsAddress(query: ChannelsQuery): string {
  return addressOf({ search: query.search, page: query.page });
}

export type Kind = "video" | "short";
export type Sort = "newest" | "popular" | "oldest";
export const SORTS: Sort[] = ["newest", "popular", "oldest"];

// The tab a channel's page opens on: its videos, or its Shorts when it has only those, as YouTube opens it
export const firstKind = (counts?: VideoCounts): Kind => (counts && !counts.video && counts.short ? "short" : "video");

// A channel's videos: its videos or its Shorts (?kind=…, when it isn't the tab the page opens on), newest first or
// in another order (?sort=popular, ?sort=oldest); or, with a search (?search=…), all those whose titles have it, newest
// first. More of them load as the list is scrolled, so no page.
export function videosQuery(params: URLSearchParams, first: Kind = "video"): VideosQuery {
  const search = searchOf(params);
  if (search) return { search };
  const kind = params.get("kind");
  const sort = params.get("sort");
  const query: VideosQuery = { kind: kind === "video" || kind === "short" ? kind : first };
  if (sort === "popular" || sort === "oldest") query.sort = sort;
  return query;
}

export function videosAddress(query: VideosQuery, first: Kind = "video"): string {
  if (query.search) return addressOf({ search: query.search });
  return addressOf({ kind: query.kind === first ? undefined : (query.kind ?? undefined), sort: query.sort });
}

// Addresses on YouTube itself: a channel's page, a video's short link (at a second, if given), and a hashtag's or a
// handle's page
export const channelOnYouTube = (id: string) => `https://www.youtube.com/channel/${id}`;
export const videoLink = (id: string, short: boolean, from = 0) =>
  (short ? `https://youtube.com/shorts/${id}` : `https://youtu.be/${id}`) + (from > 0 ? `?t=${from}` : "");
export const hashtagOnYouTube = (tag: string) => `https://www.youtube.com/hashtag/${encodeURIComponent(tag)}`;
export const handleOnYouTube = (handle: string) => `https://www.youtube.com/${handle}`;

// A channel's picture at a size: they're saved at 900 × 900 (114 KB), and YouTube's image server makes any size the
// address names
export const avatarAt = (url: string, size: number) => url.replace(/=s\d+(?=-|$)/, `=s${size}`);

// A video's cover from YouTube's image server, which has it for every video by its ID: 320 × 180 (15 KB), or 480 × 360
// with black bars above and below (23 KB), which a 16:9 frame cuts off. A Short's is its upright picture in the middle
// of those, between darkened copies of it, which an upright frame cuts off.
export const thumbnail = (id: string, size: "mq" | "hq" = "mq") => `https://i.ytimg.com/vi/${id}/${size}default.jpg`;

// The bigger one, 640 × 480 (27 KB as WebP), sharp at the size of a channel's grid; not every video has it (YouTube
// answers with a 120 × 90 grey picture instead), and the 480 × 360 one then stands in
export const bigThumbnail = (id: string) => `https://i.ytimg.com/vi_webp/${id}/sddefault.webp`;

// A Short's upright picture, 1080 × 1920 (110 KB as WebP), sharp as big as the Shorts page shows it
export const uprightThumbnail = (id: string) => `https://i.ytimg.com/vi_webp/${id}/oardefault.webp`;
