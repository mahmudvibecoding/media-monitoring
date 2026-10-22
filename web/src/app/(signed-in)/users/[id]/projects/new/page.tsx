import { ChevronLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PageLink } from "@/components/page-link";
import { ProjectEditor } from "@/components/project-editor";
import { signedInUser } from "@/lib/api-server";
import { idOf, loadOrganization } from "@/lib/organization-page";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects");
  return { title: t("newProject") };
}

// A new project's page, for admins: the form that adds it to the organization, beside what its keywords find
export default async function NewProjectPage({ params }: PageProps<"/users/[id]/projects/new">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const id = idOf((await params).id);
  const found = await loadOrganization(id);
  if (id === null || found === null) notFound();
  const t = await getTranslations();
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageLink
        href={`/users/${id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        {found ? found.organization.name : t("customers.title")}
      </PageLink>
      <h1 className="text-lg font-semibold tracking-tight">{t("projects.newProject")}</h1>
      <ProjectEditor organizationId={id} />
    </div>
  );
}
