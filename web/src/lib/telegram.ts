import type { TelegramChannelMessagesData, TelegramChannelsData } from "@/api/types.gen";
import { addressOf, pageOf, searchOf } from "@/lib/address";

export type TelegramChannelsQuery = NonNullable<TelegramChannelsData["query"]>;
export type MessagesQuery = NonNullable<TelegramChannelMessagesData["query"]>;

// The queries below come from a page's address: only values the API takes, and none that's its default, so the server
// and the browser build the same query, and so the same key for TanStack Query's cache

// The Telegram channel list's search, order and page (?search=…&sort=latest&page=2)
export function telegramChannelsQuery(params: URLSearchParams): TelegramChannelsQuery {
  const query: TelegramChannelsQuery = {};
  const search = searchOf(params);
  if (search) query.search = search;
  const sort = params.get("sort");
  if (sort === "name" || sort === "latest") query.sort = sort;
  const page = pageOf(params);
  if (page) query.page = page;
  return query;
}

export function telegramChannelsAddress(query: TelegramChannelsQuery): string {
  return addressOf({ search: query.search, sort: query.sort, page: query.page });
}

// A channel's messages: which page (?page=2)
export function messagesQuery(params: URLSearchParams): MessagesQuery {
  const page = pageOf(params);
  return page ? { page } : {};
}

export function messagesAddress(query: MessagesQuery): string {
  return addressOf({ page: query.page });
}

// Addresses on Telegram itself: a channel's, and one of its messages'
export const channelOnTelegram = (username: string) => `https://t.me/${username}`;
export const messageOnTelegram = (username: string, id: number) => `https://t.me/${username}/${id}`;
