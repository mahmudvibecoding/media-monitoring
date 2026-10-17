import { getTranslations } from "next-intl/server";

import { ChannelGhost } from "@/components/youtube-ghosts";

// A channel's page, in grey, under YouTube's top bar, while it's on its way
export default async function Loading() {
  const t = await getTranslations("common");
  return <ChannelGhost label={t("loading")} />;
}
