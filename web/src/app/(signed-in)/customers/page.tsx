import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { organizationsOptions } from "@/api/@tanstack/react-query.gen";
import { Customers } from "@/components/customers";
import { serverClient, signedInUser } from "@/lib/api-server";
import { getQueryClient } from "@/lib/query-client";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("customers");
  return { title: t("title") };
}

// The customers' organizations, for admins; the page arrives with them
export default async function CustomersPage() {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const t = await getTranslations("customers");
  const queryClient = getQueryClient();
  await queryClient.prefetchQuery(organizationsOptions({ client: serverClient }));
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-lg font-semibold tracking-tight">{t("title")}</h1>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <Customers />
      </HydrationBoundary>
    </div>
  );
}
