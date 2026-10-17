import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { YouTubeChannels } from "@/components/youtube-channels";
import { signedInUser } from "@/lib/api-server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("youtubeChannels");
  return { title: t("title") };
}

// The monitored YouTube channels, for admins. The browser asks for them itself: a page holds as many as fit the
// screen, which only the browser knows.
export default async function YouTubeChannelsPage() {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  return <YouTubeChannels />;
}
