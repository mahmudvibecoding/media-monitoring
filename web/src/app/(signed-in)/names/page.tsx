import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { disagreementsOptions } from "@/api/@tanstack/react-query.gen";
import { NameDisagreements } from "@/components/name-disagreements";
import { toSearchParams } from "@/lib/address";
import { serverClient, signedInUser } from "@/lib/api-server";
import { disagreementsQuery } from "@/lib/names";
import { getQueryClient } from "@/lib/query-client";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("names");
  return { title: t("title") };
}

// The labelled texts where a model's names differ from those labelled by hand, for admins (see NameDisagreements);
// the page arrives with the first of them
export default async function NamesPage({ searchParams }: PageProps<"/names">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const t = await getTranslations("names");
  const query = disagreementsQuery(toSearchParams(await searchParams));
  const queryClient = getQueryClient();
  await queryClient.prefetchQuery(disagreementsOptions({ client: serverClient, query }));
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 pb-10 sm:px-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <NameDisagreements />
      </HydrationBoundary>
    </div>
  );
}
