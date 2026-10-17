import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { telegramChannelMessagesInfiniteOptions, telegramChannelQueryKey } from "@/api/@tanstack/react-query.gen";
import { telegramChannel } from "@/api/sdk.gen";
import { TelegramChat } from "@/components/telegram-chat";
import { serverClient, signedInUser } from "@/lib/api-server";
import { FIRST_PAGE } from "@/lib/pages";
import { getQueryClient } from "@/lib/query-client";

// The channel, asked for once per page load though both the tab's title and the page need it: null when there's no
// such channel (or the address has no number for one), undefined when the API didn't say (the browser then asks
// again, and shows why if it fails again)
const loadChannel = cache(async (id: number | null) => {
  if (id === null) return null;
  const { data, response } = await telegramChannel({ client: serverClient, path: { channel_id: id } });
  if (data) return data;
  return response?.status === 404 || response?.status === 422 ? null : undefined;
});

// The channel's ID in the address: Telegram's number for it
function idOf(given: string): number | null {
  return /^\d{1,15}$/.test(given) ? Number(given) : null;
}

export async function generateMetadata({ params }: PageProps<"/telegram/channels/[id]">): Promise<Metadata> {
  const channel = await loadChannel(idOf((await params).id));
  return channel ? { title: channel.title?.trim() || `@${channel.username}` } : {};
}

// A monitored Telegram channel's chat, for admins, beside the chat list, as in Telegram Web: its details and its newest
// messages arrive with the page, and the browser takes over from there
export default async function TelegramChannelPage({ params }: PageProps<"/telegram/channels/[id]">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const id = idOf((await params).id);
  const channel = await loadChannel(id);
  if (id === null || channel === null) notFound();
  const queryClient = getQueryClient();
  if (channel) queryClient.setQueryData(telegramChannelQueryKey({ path: { channel_id: id } }), channel);
  await queryClient.prefetchInfiniteQuery({
    ...telegramChannelMessagesInfiniteOptions({ client: serverClient, path: { channel_id: id } }),
    ...FIRST_PAGE,
  });
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TelegramChat id={id} />
    </HydrationBoundary>
  );
}
