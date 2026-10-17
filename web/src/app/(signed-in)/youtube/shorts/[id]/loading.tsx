import { getTranslations } from "next-intl/server";

import { ShortsGhost } from "@/components/youtube-ghosts";

// A Short's page, in grey, under YouTube's top bar, while it's on its way
export default async function Loading() {
  const t = await getTranslations("common");
  return <ShortsGhost label={t("loading")} />;
}
