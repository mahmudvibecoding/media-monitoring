import { getTranslations } from "next-intl/server";

import { WatchGhost } from "@/components/youtube-ghosts";

// A video's page, in grey, under YouTube's top bar, while it's on its way
export default async function Loading() {
  const t = await getTranslations("common");
  return <WatchGhost label={t("loading")} />;
}
