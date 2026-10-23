import type { TelegramChannelMessagesData, TelegramChannelsData } from "@/api/types.gen";

export type TelegramChannelsQuery = NonNullable<TelegramChannelsData["query"]>;
export type TelegramSort = NonNullable<TelegramChannelsQuery["sort"]>;
type TelegramMessagesQuery = NonNullable<TelegramChannelMessagesData["query"]>;
// The chat list's folders: its two orders, and the channels with names labelled by hand
export type TelegramFolder = TelegramSort | "labelled";
// Whose names a labelled chat marks: those labelled by hand, or Claude's as first made, or a model's, compared with them
export type Labeller = NonNullable<TelegramMessagesQuery["source"]>;
export const LABELLERS = [
  "hand",
  "claude",
  "gemma",
  "glot500",
  "xlmv",
  "minilm",
] as const satisfies readonly Labeller[];

// The labeller in a chat's address: ?labelled for the names labelled by hand, ?labelled=gemma for a model's; null for
// a chat with all its messages
export function labellerOf(value: string | string[] | null | undefined): Labeller | null {
  if (value === null || value === undefined) return null;
  return LABELLERS.find((labeller) => labeller === value) ?? "hand";
}

// The chat list's query: only what isn't the API's default, so that the server and the browser build the same one,
// and so the same key for TanStack Query's cache. A search looks through all the channels, as Telegram's does, in the
// folder's order.
export function channelsQuery(folder: TelegramFolder, search: string): TelegramChannelsQuery {
  const query: TelegramChannelsQuery = {};
  if (search) query.search = search;
  if (folder === "latest") query.sort = folder;
  if (folder === "labelled" && !search) query.labelled = true;
  return query;
}

// A chat's query, the same way: none at all for its newest messages, which its page arrives with
export function messagesQuery(search: string, labelled: Labeller | null): TelegramMessagesQuery | undefined {
  const query: TelegramMessagesQuery = {};
  if (search) query.search = search;
  if (labelled) query.labelled = true;
  if (labelled && labelled !== "hand") query.source = labelled;
  return search || labelled ? query : undefined;
}

// The device a page shows on, from the browser's name, for Telegram's looks on it (globals.css's .telegram); an iPad
// calls itself a Mac
export type Platform = "mac" | "ios" | "other";
export function platformOf(userAgent: string): Platform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  return /Macintosh/.test(userAgent) ? "mac" : "other";
}

// A chat's path here, and the ID in it (null on the list's own page). Opened from the labelled folder, the chat shows
// only the labelled messages, with the names labelled by hand or a model's (see labellerOf).
export function chatPath(id: number, labelled: Labeller | null = null): string {
  if (labelled === null) return `/telegram/channels/${id}`;
  return `/telegram/channels/${id}?labelled${labelled === "hand" ? "" : `=${labelled}`}`;
}
export function chatIdOf(path: string): number | null {
  const id = /^\/telegram\/channels\/(\d{1,15})(?:\/|$)/.exec(path)?.[1];
  return id ? Number(id) : null;
}

// A channel's post on Telegram itself
export const messageOnTelegram = (username: string, id: number) => `https://t.me/${username}/${id}`;
