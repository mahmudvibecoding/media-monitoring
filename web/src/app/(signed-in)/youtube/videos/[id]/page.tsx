import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { ChevronLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { youtubeVideoCommentsOptions, youtubeVideoQueryKey } from "@/api/@tanstack/react-query.gen";
import { youtubeVideo } from "@/api/sdk.gen";
import { VideoComments, VideoDetails } from "@/components/youtube-video";
import { toSearchParams } from "@/lib/address";
import { serverClient, signedInUser } from "@/lib/api-server";
import { getQueryClient } from "@/lib/query-client";
import { commentsQuery } from "@/lib/youtube";

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

// A collected YouTube video, for admins: its details, and its comments as the address asks for them (page). The page
// arrives with both, and the browser takes over from there.
export default async function YouTubeVideoPage({ params, searchParams }: PageProps<"/youtube/videos/[id]">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const { id } = await params;
  const video = await loadVideo(id);
  if (video === null) notFound();
  const query = commentsQuery(toSearchParams(await searchParams));
  const queryClient = getQueryClient();
  if (video) queryClient.setQueryData(youtubeVideoQueryKey({ path: { video_id: id } }), video);
  await queryClient.prefetchQuery(youtubeVideoCommentsOptions({ client: serverClient, path: { video_id: id }, query }));
  return (
    <div className="space-y-6">
      {video && (
        <Link
          href={`/youtube/channels/${video.channel_id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" />
          {video.channel_title?.trim() || video.channel_id}
        </Link>
      )}
      <HydrationBoundary state={dehydrate(queryClient)}>
        <VideoDetails id={id} />
        <VideoComments id={id} />
      </HydrationBoundary>
    </div>
  );
}
