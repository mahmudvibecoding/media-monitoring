import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { ChevronLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { cache } from "react";

import { youtubeChannelQueryKey, youtubeChannelVideosInfiniteOptions } from "@/api/@tanstack/react-query.gen";
import { youtubeChannel } from "@/api/sdk.gen";
import { ChannelDetails, ChannelVideos } from "@/components/youtube-channel";
import { toSearchParams } from "@/lib/address";
import { serverClient, signedInUser } from "@/lib/api-server";
import { FIRST_PAGE } from "@/lib/pages";
import { getQueryClient } from "@/lib/query-client";
import { videosQuery } from "@/lib/youtube";

// The channel, asked for once per page load though both the tab's title and the page need it: null when there's no
// such channel, undefined when the API didn't say (the browser then asks again, and shows why if it fails again)
const loadChannel = cache(async (id: string) => {
  const { data, response } = await youtubeChannel({ client: serverClient, path: { channel_id: id } });
  if (data) return data;
  return response?.status === 404 || response?.status === 422 ? null : undefined;
});

export async function generateMetadata({ params }: PageProps<"/youtube/channels/[id]">): Promise<Metadata> {
  const channel = await loadChannel((await params).id);
  return channel ? { title: channel.title?.trim() || channel.id } : {};
}

// A monitored YouTube channel, for admins: its details, and its videos of the kind the address asks for. The page
// arrives with both (the first 50 videos), and the browser takes over from there.
export default async function YouTubeChannelPage({ params, searchParams }: PageProps<"/youtube/channels/[id]">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const { id } = await params;
  const channel = await loadChannel(id);
  if (channel === null) notFound();
  const t = await getTranslations("youtubeChannel");
  const query = videosQuery(toSearchParams(await searchParams));
  const queryClient = getQueryClient();
  if (channel) queryClient.setQueryData(youtubeChannelQueryKey({ path: { channel_id: id } }), channel);
  await queryClient.prefetchInfiniteQuery({
    ...youtubeChannelVideosInfiniteOptions({ client: serverClient, path: { channel_id: id }, query }),
    ...FIRST_PAGE,
  });
  return (
    <div className="space-y-6">
      <Link
        href="/youtube/channels"
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        {t("back")}
      </Link>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <ChannelDetails id={id} />
        <ChannelVideos id={id} />
      </HydrationBoundary>
    </div>
  );
}
