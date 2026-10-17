import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { runsOptions } from "@/api/@tanstack/react-query.gen";
import { Activity } from "@/components/activity";
import { runsQuery } from "@/lib/activity";
import { toSearchParams } from "@/lib/address";
import { serverClient, signedInUser } from "@/lib/api-server";
import { getQueryClient } from "@/lib/query-client";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("activity");
  return { title: t("title") };
}

// Every run, for admins: the page arrives with the runs its address asks for (step, page), and the browser takes over
// from there
export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const t = await getTranslations("activity");
  const query = runsQuery(toSearchParams(await searchParams));
  const queryClient = getQueryClient();
  await queryClient.prefetchQuery(runsOptions({ client: serverClient, query }));
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <Activity />
      </HydrationBoundary>
    </div>
  );
}
