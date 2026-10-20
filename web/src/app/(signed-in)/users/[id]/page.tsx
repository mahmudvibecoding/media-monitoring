import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { ChevronLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { cache } from "react";

import { organizationDetailsQueryKey } from "@/api/@tanstack/react-query.gen";
import { organizationDetails } from "@/api/sdk.gen";
import { Customer } from "@/components/customer";
import { PageLink } from "@/components/page-link";
import { serverClient, signedInUser } from "@/lib/api-server";
import { getQueryClient } from "@/lib/query-client";

// The organization, asked for once per page load though both the tab's title and the page need it: null when there's
// no such organization (or the address has no number for one), undefined when the API didn't say (the browser then
// asks again, and shows why if it fails again)
const loadOrganization = cache(async (id: number | null) => {
  if (id === null) return null;
  const { data, response } = await organizationDetails({ client: serverClient, path: { organization_id: id } });
  if (data) return data;
  return response?.status === 404 || response?.status === 422 ? null : undefined;
});

function idOf(given: string): number | null {
  return /^\d{1,15}$/.test(given) ? Number(given) : null;
}

export async function generateMetadata({ params }: PageProps<"/users/[id]">): Promise<Metadata> {
  const found = await loadOrganization(idOf((await params).id));
  return found ? { title: found.organization.name } : {};
}

// One customer organization, for admins: its name and state, and its people; the page arrives with them
export default async function OrganizationPage({ params }: PageProps<"/users/[id]">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const id = idOf((await params).id);
  const found = await loadOrganization(id);
  if (id === null || found === null) notFound();
  const t = await getTranslations("customers");
  const queryClient = getQueryClient();
  if (found) queryClient.setQueryData(organizationDetailsQueryKey({ path: { organization_id: id } }), found);
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
