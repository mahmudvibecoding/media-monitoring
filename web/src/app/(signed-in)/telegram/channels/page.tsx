import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { signedInUser } from "@/lib/api-server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("telegramChannels");
  return { title: t("title") };
}

// The chat list's own page, for admins: the list is the layout's, in its panel at the left; beside it, the wallpaper
// alone until a chat is chosen, as in Telegram Web
export default async function TelegramChannelsPage() {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  return null;
}
