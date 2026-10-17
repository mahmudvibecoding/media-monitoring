import { getTranslations } from "next-intl/server";

import { ChannelsGhost } from "@/components/youtube-ghosts";

// The channels' list, in grey, under YouTube's top bar, while it's on its way
export default async function Loading() {
  const t = await getTranslations("common");
  return <ChannelsGhost label={t("loading")} />;
}
