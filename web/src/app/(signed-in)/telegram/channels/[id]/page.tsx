import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { ChevronLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { cache } from "react";

import { telegramChannelMessagesOptions, telegramChannelQueryKey } from "@/api/@tanstack/react-query.gen";
import { telegramChannel } from "@/api/sdk.gen";
import { TelegramChannelDetails, TelegramChannelMessages } from "@/components/telegram-channel";
import { toSearchParams } from "@/lib/address";
import { serverClient, signedInUser } from "@/lib/api-server";
import { getQueryClient } from "@/lib/query-client";
import { messagesQuery } from "@/lib/telegram";

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

// A monitored Telegram channel, for admins: its details, and its saved messages as the address asks for them (page).
// The page arrives with both, and the browser takes over from there.
export default async function TelegramChannelPage({ params, searchParams }: PageProps<"/telegram/channels/[id]">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const id = idOf((await params).id);
  const channel = await loadChannel(id);
  if (id === null || channel === null) notFound();
  const t = await getTranslations("telegramChannel");
  const query = messagesQuery(toSearchParams(await searchParams));
  const queryClient = getQueryClient();
  if (channel) queryClient.setQueryData(telegramChannelQueryKey({ path: { channel_id: id } }), channel);
  await queryClient.prefetchQuery(
    telegramChannelMessagesOptions({ client: serverClient, path: { channel_id: id }, query }),
  );
  return (
    <div className="space-y-6">
      <Link
        href="/telegram/channels"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        {t("back")}
      </Link>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <TelegramChannelDetails id={id} />
        <TelegramChannelMessages id={id} />
      </HydrationBoundary>
    </div>
  );
}
