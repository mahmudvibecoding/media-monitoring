import type { TelegramChannelsData } from "@/api/types.gen";

export type TelegramChannelsQuery = NonNullable<TelegramChannelsData["query"]>;
export type TelegramSort = NonNullable<TelegramChannelsQuery["sort"]>;
// For a while: folders of the channels a model found related to Uzbekistan, unrelated, or unsure, the biggest first
export type TelegramLabel = NonNullable<TelegramChannelsQuery["label"]>;
export type TelegramFolder = TelegramSort | TelegramLabel;

// The chat list's query: only what isn't the API's default, so that the server and the browser build the same one,
// and so the same key for TanStack Query's cache. A search looks through every channel, whichever folder is open.
export function channelsQuery(folder: TelegramFolder, search: string): TelegramChannelsQuery {
  const query: TelegramChannelsQuery = {};
  if (search) query.search = search;
  if (folder === "latest") query.sort = folder;
  else if (folder !== "subscribers" && !search) query.label = folder;
  return query;
}

// The device a page shows on, from the browser's name, for Telegram's looks on it (globals.css's .telegram); an iPad
// calls itself a Mac
export type Platform = "mac" | "ios" | "other";
export function platformOf(userAgent: string): Platform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  return /Macintosh/.test(userAgent) ? "mac" : "other";
}

// A chat's path here, and the ID in it (null on the list's own page)
export const chatPath = (id: number) => `/telegram/channels/${id}`;
export function chatIdOf(path: string): number | null {
  const id = /^\/telegram\/channels\/(\d{1,15})(?:\/|$)/.exec(path)?.[1];
  return id ? Number(id) : null;
}

// A channel's post on Telegram itself
export const messageOnTelegram = (username: string, id: number) => `https://t.me/${username}/${id}`;
