import type { TelegramChannelMessagesData, TelegramChannelsData } from "@/api/types.gen";

export type TelegramChannelsQuery = NonNullable<TelegramChannelsData["query"]>;
export type TelegramSort = NonNullable<TelegramChannelsQuery["sort"]>;
type TelegramMessagesQuery = NonNullable<TelegramChannelMessagesData["query"]>;
// The chat list's folders: its two orders, and the channels with messages labelled by hand
export type TelegramFolder = TelegramSort | "labelled";

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
export function messagesQuery(search: string, labelled: boolean): TelegramMessagesQuery | undefined {
  const query: TelegramMessagesQuery = {};
  if (search) query.search = search;
  if (labelled) query.labelled = true;
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
// only the messages labelled by hand (?labelled).
export const chatPath = (id: number, labelled = false) => `/telegram/channels/${id}${labelled ? "?labelled" : ""}`;
export function chatIdOf(path: string): number | null {
  const id = /^\/telegram\/channels\/(\d{1,15})(?:\/|$)/.exec(path)?.[1];
  return id ? Number(id) : null;
}

// A channel's post on Telegram itself
export const messageOnTelegram = (username: string, id: number) => `https://t.me/${username}/${id}`;
