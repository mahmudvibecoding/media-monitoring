import { useTranslations } from "next-intl";

import { Skeleton } from "@/components/ui/skeleton";

// A channel list's shape while its first channels load
export function ListSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="space-y-2 rounded-xl border p-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: 10 }, (_, row) => (
        <div key={row} className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
