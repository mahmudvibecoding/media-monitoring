import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import {
  youtubeChannelVideosInfiniteOptions,
  youtubeVideoCommentsInfiniteOptions,
  youtubeVideoQueryKey,
} from "@/api/@tanstack/react-query.gen";
import { youtubeVideo } from "@/api/sdk.gen";
import { VideoPage } from "@/components/youtube-video";
import { serverClient, signedInUser } from "@/lib/api-server";
import { FIRST_PAGE } from "@/lib/pages";
import { getQueryClient } from "@/lib/query-client";

// The video, asked for once per page load though both the tab's title and the page need it: null when there's no
// such video, undefined when the API didn't say (the browser then asks again, and shows why if it fails again)
const loadVideo = cache(async (id: string) => {
  const { data, response } = await youtubeVideo({ client: serverClient, path: { video_id: id } });
  if (data) return data;
  return response?.status === 404 || response?.status === 422 ? null : undefined;
});

export async function generateMetadata({ params }: PageProps<"/youtube/videos/[id]">): Promise<Metadata> {
  const video = await loadVideo((await params).id);
  return video ? { title: video.title?.trim() || video.id } : {};
}

// A collected YouTube video, for admins, laid out like YouTube's page: its details, its first comments and its
// channel's newest videos (the first page of the channel's Videos tab, which its page then has already) arrive with
// the page, and the browser takes over from there
export default async function YouTubeVideoPage({ params }: PageProps<"/youtube/videos/[id]">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const { id } = await params;
  const video = await loadVideo(id);
  if (video === null) notFound();
  const queryClient = getQueryClient();
  if (video) queryClient.setQueryData(youtubeVideoQueryKey({ path: { video_id: id } }), video);
  await Promise.all([
    queryClient.prefetchInfiniteQuery({
      ...youtubeVideoCommentsInfiniteOptions({ client: serverClient, path: { video_id: id } }),
      ...FIRST_PAGE,
    }),
    video &&
      queryClient.prefetchInfiniteQuery({
        ...youtubeChannelVideosInfiniteOptions({
          client: serverClient,
          path: { channel_id: video.channel_id },
          query: { kind: "video" },
        }),
        ...FIRST_PAGE,
      }),
  ]);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <VideoPage id={id} />
    </HydrationBoundary>
  );
}
