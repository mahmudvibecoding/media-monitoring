import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { youtubeChannelsOptions } from "@/api/@tanstack/react-query.gen";
import { YouTubeChannels } from "@/components/youtube-channels";
import { toSearchParams } from "@/lib/address";
import { serverClient, signedInUser } from "@/lib/api-server";
import { getQueryClient } from "@/lib/query-client";
import { channelsQuery } from "@/lib/youtube";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("youtubeChannels");
  return { title: t("title") };
}

// The monitored YouTube channels, for admins: the page arrives with the list its address asks for (search, order,
// page), and the browser takes over from there
export default async function YouTubeChannelsPage({ searchParams }: PageProps<"/youtube/channels">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const t = await getTranslations("youtubeChannels");
  const query = channelsQuery(toSearchParams(await searchParams));
  const queryClient = getQueryClient();
  await queryClient.prefetchQuery(youtubeChannelsOptions({ client: serverClient, query }));
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <YouTubeChannels />
      </HydrationBoundary>
    </div>
  );
}
