import { ChevronLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PageLink } from "@/components/page-link";
import { ProjectEditor } from "@/components/project-editor";
import { signedInUser } from "@/lib/api-server";
import { idOf, loadOrganization, loadProject } from "@/lib/organization-page";

export async function generateMetadata({ params }: PageProps<"/users/[id]/projects/[projectId]">): Promise<Metadata> {
  const project = await loadProject(idOf((await params).projectId));
  return project ? { title: project.name } : {};
}

// A project's page, for admins: its form, to change it or disable it, beside what its keywords find
export default async function ProjectPage({ params }: PageProps<"/users/[id]/projects/[projectId]">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const given = await params;
  const id = idOf(given.id);
  const [found, project] = await Promise.all([loadOrganization(id), loadProject(idOf(given.projectId))]);
  if (id === null || found === null || project === null || (project && project.organization_id !== id)) notFound();
  if (project === undefined) throw new Error("The API didn't answer"); // the error page, with a way to try again
  const t = await getTranslations("customers");
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageLink
        href={`/users/${id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        {found ? found.organization.name : t("title")}
      </PageLink>
      <h1 className="text-lg font-semibold tracking-tight">{project.name}</h1>
      <ProjectEditor organizationId={id} project={project} />
    </div>
  );
}
