import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import {
  youtubeChannelOptions,
  youtubeChannelVideosInfiniteOptions,
  youtubeVideoQueryKey,
} from "@/api/@tanstack/react-query.gen";
import { youtubeVideo } from "@/api/sdk.gen";
import { ShortsPage } from "@/components/youtube-shorts";
import { toSearchParams } from "@/lib/address";
import { serverClient, signedInUser } from "@/lib/api-server";
import { FIRST_PAGE } from "@/lib/pages";
import { getQueryClient } from "@/lib/query-client";

// The Short, asked for once per page load though both the tab's title and the page need it: null when there's no
// such video, undefined when the API didn't say (the browser then asks again, and shows why if it fails again)
const loadVideo = cache(async (id: string) => {
  const { data, response } = await youtubeVideo({ client: serverClient, path: { video_id: id } });
  if (data) return data;
  return response?.status === 404 || response?.status === 422 ? null : undefined;
});

export async function generateMetadata({ params }: PageProps<"/youtube/shorts/[id]">): Promise<Metadata> {
  const video = await loadVideo((await params).id);
  return video ? { title: video.title?.trim() || video.id } : {};
}

// A collected Short, for admins, played as YouTube plays Shorts (a video that isn't one opens on its watch page). Its
// details, its channel's and the channel's first Shorts, in the order the address asks for (the order of the grid it
// was opened from), arrive with the page, and the browser takes over from there.
export default async function YouTubeShortPage({ params, searchParams }: PageProps<"/youtube/shorts/[id]">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const { id } = await params;
  const video = await loadVideo(id);
  if (video === null) notFound();
  if (video && video.kind !== "short") redirect(`/youtube/videos/${id}`);
  const asked = toSearchParams(await searchParams).get("sort");
  const sort = asked === "popular" || asked === "oldest" ? asked : undefined;
  const queryClient = getQueryClient();
  if (video) {
    queryClient.setQueryData(youtubeVideoQueryKey({ path: { video_id: id } }), video);
    await Promise.all([
      queryClient.prefetchQuery(
        youtubeChannelOptions({ client: serverClient, path: { channel_id: video.channel_id } }),
      ),
      queryClient.prefetchInfiniteQuery({
        ...youtubeChannelVideosInfiniteOptions({
          client: serverClient,
          path: { channel_id: video.channel_id },
          query: sort ? { kind: "short", sort } : { kind: "short" },
        }),
        ...FIRST_PAGE,
      }),
    ]);
  }
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ShortsPage id={id} />
    </HydrationBoundary>
  );
}
