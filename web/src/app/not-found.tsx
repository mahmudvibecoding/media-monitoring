import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";

// Any address the site doesn't have, answered with status 404
export default async function NotFound() {
  const t = await getTranslations("notFound");
  return (
    <>
      <Header />
      <main className="mx-auto max-w-7xl space-y-4 px-6 py-8">
        <h1 className="text-lg font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
        <Button nativeButton={false} render={<Link href="/" />}>
          {t("home")}
        </Button>
      </main>
    </>
  );
}
