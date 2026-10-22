import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { ChevronLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { organizationDetailsQueryKey, projectsOptions } from "@/api/@tanstack/react-query.gen";
import { Customer } from "@/components/customer";
import { PageLink } from "@/components/page-link";
import { serverClient, signedInUser } from "@/lib/api-server";
import { idOf, loadOrganization } from "@/lib/organization-page";
import { getQueryClient } from "@/lib/query-client";

export async function generateMetadata({ params }: PageProps<"/users/[id]">): Promise<Metadata> {
  const found = await loadOrganization(idOf((await params).id));
  return found ? { title: found.organization.name } : {};
}

// One customer organization, for admins: its name and state, its people and its projects; the page arrives with them
export default async function OrganizationPage({ params }: PageProps<"/users/[id]">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const id = idOf((await params).id);
  const found = await loadOrganization(id);
  if (id === null || found === null) notFound();
  const t = await getTranslations("customers");
  const queryClient = getQueryClient();
  if (found) queryClient.setQueryData(organizationDetailsQueryKey({ path: { organization_id: id } }), found);
  await queryClient.prefetchQuery(projectsOptions({ client: serverClient, path: { organization_id: id } }));
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageLink
        href="/users"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        {t("title")}
      </PageLink>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <Customer id={id} />
      </HydrationBoundary>
    </div>
  );
}
