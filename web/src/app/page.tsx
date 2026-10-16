import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { getTranslations } from "next-intl/server";

import { statusOptions } from "@/api/@tanstack/react-query.gen";
import { Status } from "@/components/status";
import { getQueryClient } from "@/lib/query-client";

export default async function Home() {
  const t = await getTranslations("home");
  const queryClient = getQueryClient();
  await queryClient.prefetchQuery(statusOptions()); // so the page arrives with the numbers already in it
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <Status />
      </HydrationBoundary>
    </div>
  );
}
