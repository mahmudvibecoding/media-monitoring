"use client";

import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { projectsOptions } from "@/api/@tanstack/react-query.gen";
import { ApiError } from "@/components/api-error";
import { StatusBadge } from "@/components/customers";
import { PageLink } from "@/components/page-link";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// An organization's projects, for admins: each by name, with its keywords and whether it's disabled, opening its
// page, where it's changed; and a button to the page that adds one
export function Projects({ id }: { id: number }) {
  const t = useTranslations("projects");
  const { data, error, refetch, isRefetching } = useQuery(projectsOptions({ path: { organization_id: id } }));
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{t("title")}</h2>
        <PageLink href={`/users/${id}/projects/new`} className={buttonVariants({ size: "sm" })}>
          <PlusIcon />
          {t("add")}
        </PageLink>
      </div>
      {error && <ApiError error={error} retry={() => refetch()} retrying={isRefetching} />}
      {data &&
        (data.length === 0 ? (
          <p className="text-muted-foreground">{t("empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead>{t("keywords")}</TableHead>
                <TableHead>{t("status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((project) => (
                <TableRow key={project.id}>
                  <TableCell className="font-medium">
                    <PageLink href={`/users/${id}/projects/${project.id}`} className="hover:underline">
                      {project.name}
                    </PageLink>
                  </TableCell>
                  <TableCell className="max-w-md truncate text-muted-foreground" title={project.keywords.join(", ")}>
                    {project.keywords.join(", ")}
                  </TableCell>
                  <TableCell>
                    <StatusBadge disabled={project.disabled} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </section>
  );
}
