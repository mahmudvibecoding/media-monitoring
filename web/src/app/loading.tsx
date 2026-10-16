import { getTranslations } from "next-intl/server";

import { Skeleton } from "@/components/ui/skeleton";

// While a page is rendered: a placeholder in the shape of a heading and its content
export default async function Loading() {
  const t = await getTranslations("common");
  return (
    <div className="space-y-6" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}
