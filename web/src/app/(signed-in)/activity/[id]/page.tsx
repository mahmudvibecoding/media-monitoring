import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { ChevronLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getMessages, getTranslations } from "next-intl/server";
import { cache } from "react";

import { runDetailsQueryKey } from "@/api/@tanstack/react-query.gen";
import { runDetails } from "@/api/sdk.gen";
import { RunDetails } from "@/components/run-details";
import { serverClient, signedInUser } from "@/lib/api-server";
import { getQueryClient } from "@/lib/query-client";

// The run, asked for once per page load though both the tab's title and the page need it: null when there's no such
// run (or the address has no number for one), undefined when the API didn't say (the browser then asks again, and
// shows why if it fails again)
const loadRun = cache(async (id: number | null) => {
  if (id === null) return null;
  const { data, response } = await runDetails({ client: serverClient, path: { run_id: id } });
  if (data) return data;
  return response?.status === 404 || response?.status === 422 ? null : undefined;
});

function idOf(given: string): number | null {
  return /^\d{1,15}$/.test(given) ? Number(given) : null;
}

export async function generateMetadata({ params }: PageProps<"/activity/[id]">): Promise<Metadata> {
  const run = await loadRun(idOf((await params).id));
  if (!run) return {};
  const steps: Record<string, { name: string }> = (await getMessages()).activity.steps;
  return { title: steps[run.step]?.name ?? run.step };
}

// One run, for admins, with all its numbers; the page arrives with it, and asks again while it runs
export default async function RunPage({ params }: PageProps<"/activity/[id]">) {
  const user = await signedInUser();
  if (user?.role !== "admin") notFound();
  const id = idOf((await params).id);
  const run = await loadRun(id);
  if (id === null || run === null) notFound();
  const t = await getTranslations("activity");
  const queryClient = getQueryClient();
  if (run) queryClient.setQueryData(runDetailsQueryKey({ path: { run_id: id } }), run);
  return (
    <div className="space-y-6">
      <Link
        href="/activity"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-4" />
        {t("back")}
      </Link>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <RunDetails id={id} />
      </HydrationBoundary>
    </div>
  );
}
