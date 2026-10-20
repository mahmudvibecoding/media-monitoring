"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

import { addOrganizationMutation, organizationsOptions, organizationsQueryKey } from "@/api/@tanstack/react-query.gen";
import { ApiError } from "@/components/api-error";
import { PageLink } from "@/components/page-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCount, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// The customers' organizations, for admins: by name, each with how many people it has, when it was added and whether
// it's disabled, and a form above them that adds one and opens its page, where its people are added
export function Customers() {
  const t = useTranslations("customers");
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data, error, refetch, isRefetching } = useQuery(organizationsOptions());
  const add = useMutation(addOrganizationMutation());
  const [name, setName] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const added = await add.mutateAsync({ body: { name } }).catch(() => null); // add.error shows what failed
    if (!added) return;
    await queryClient.invalidateQueries({ queryKey: organizationsQueryKey() });
    router.push(`/users/${added.id}`);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="flex flex-wrap items-start gap-2">
        <Input
          aria-label={t("newName")}
          placeholder={t("newName")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          required
          className="w-72 max-w-full"
        />
        <Button type="submit" disabled={add.isPending}>
          <PlusIcon />
          {t(add.isPending ? "adding" : "add")}
        </Button>
      </form>
      {add.error && <ApiError error={add.error} />}
      {error && <ApiError error={error} retry={() => refetch()} retrying={isRefetching} />}
      {data &&
        (data.length === 0 ? (
          <p className="text-muted-foreground">{t("empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead className="text-right">{t("people")}</TableHead>
                <TableHead>{t("added")}</TableHead>
                <TableHead>{t("status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((organization) => (
                <TableRow key={organization.id}>
                  <TableCell className="font-medium">
                    <PageLink href={`/users/${organization.id}`} className="hover:underline">
                      {organization.name}
                    </PageLink>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(organization.people, locale)}</TableCell>
                  <TableCell className="tabular-nums">{formatDate(organization.created_at, locale)}</TableCell>
                  <TableCell>
                    <StatusBadge disabled={organization.disabled} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </div>
  );
}

// Active or disabled, in words, the disabled ones grayed out
export function StatusBadge({ disabled }: { disabled: boolean }) {
  const t = useTranslations("customers");
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        disabled
          ? "bg-muted text-muted-foreground"
          : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
      )}
    >
      {t(disabled ? "disabled" : "active")}
    </span>
  );
}
