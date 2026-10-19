import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { getTranslations } from "next-intl/server";

import { runsOptions, statusOptions } from "@/api/@tanstack/react-query.gen";
import { Activity } from "@/components/activity";
import { EnglishOnly } from "@/components/english-only";
import { Status } from "@/components/status";
import { runsQuery } from "@/lib/activity";
import { toSearchParams } from "@/lib/address";
import { serverClient, signedInUser } from "@/lib/api-server";
import { getQueryClient } from "@/lib/query-client";

// The home page: for admins, how much the database holds, then the activity, every run, as the address asks for
// (?step=…&page=…); for customers, a greeting, as there's nothing of theirs yet
export default async function Home({ searchParams }: PageProps<"/">) {
  const t = await getTranslations("home");
  const user = await signedInUser();
  if (user?.role !== "admin") {
    return (
      <div className="space-y-2">
        <h1 className="text-lg font-semibold tracking-tight">{t("greeting", { name: user?.name ?? "" })}</h1>
        <p className="text-muted-foreground">{t("empty")}</p>
      </div>
    );
  }
  const activity = await getTranslations({ locale: "en", namespace: "activity" }); // in English, as the whole activity
  const query = runsQuery(toSearchParams(await searchParams));
  const queryClient = getQueryClient();
  // So the page arrives with the numbers and the runs, both asked for at once
  await Promise.all([
    queryClient.prefetchQuery(statusOptions({ client: serverClient })),
    queryClient.prefetchQuery(runsOptions({ client: serverClient, query })),
  ]);
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <h1 className="text-lg font-semibold tracking-tight">{t("title")}</h1>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <Status />
        <section id="activity" className="scroll-mt-6 space-y-2">
          <h2 className="font-medium text-muted-foreground">{activity("title")}</h2>
          <EnglishOnly>
            <Activity />
          </EnglishOnly>
        </section>
      </HydrationBoundary>
    </div>
  );
}
