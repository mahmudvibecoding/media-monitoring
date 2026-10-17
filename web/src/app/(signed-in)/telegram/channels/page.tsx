import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { telegramChannelsOptions } from "@/api/@tanstack/react-query.gen";
import { TelegramChannels } from "@/components/telegram-channels";
import { toSearchParams } from "@/lib/address";
import { serverClient, signedInUser } from "@/lib/api-server";
import { getQueryClient } from "@/lib/query-client";
import { telegramChannelsQuery } from "@/lib/telegram";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("telegramChannels");
  return { title: t("title") };
}

// The monitored Telegram channels, for admins: the page arrives with the list its address asks for (search, order,
// page), and the browser takes over from there
export default async function TelegramChannelsPage({ searchParams }: PageProps<"/telegram/channels">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const t = await getTranslations("telegramChannels");
  const query = telegramChannelsQuery(toSearchParams(await searchParams));
  const queryClient = getQueryClient();
  await queryClient.prefetchQuery(telegramChannelsOptions({ client: serverClient, query }));
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <TelegramChannels />
      </HydrationBoundary>
    </div>
  );
}
