import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { getTranslations } from "next-intl/server";

import { statusOptions } from "@/api/@tanstack/react-query.gen";
import { Status } from "@/components/status";
import { serverClient, signedInUser } from "@/lib/api-server";
import { getQueryClient } from "@/lib/query-client";

// The home page: for admins, how much the database holds; for customers, a greeting, as there's nothing of theirs yet
export default async function Home() {
  const t = await getTranslations("home");
  const user = await signedInUser();
  if (user?.role !== "admin") {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("greeting", { name: user?.name ?? "" })}</h1>
        <p className="text-muted-foreground">{t("empty")}</p>
      </div>
    );
  }
  const queryClient = getQueryClient();
  await queryClient.prefetchQuery(statusOptions({ client: serverClient })); // so the page arrives with the numbers
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <Status />
      </HydrationBoundary>
    </div>
  );
}
