"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { startTransition } from "react";

import { Button } from "@/components/ui/button";

// A page that failed while it was rendered: a message, the error's code (Next's digest, which is in the server's log
// too), and a button that renders the page again on the server
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("errorPage");
  const router = useRouter();

  function retry() {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <div role="alert" className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-muted-foreground">{t("description")}</p>
      {error.digest && <p className="text-sm text-muted-foreground">{t("code", { code: error.digest })}</p>}
      <Button onClick={retry}>{t("retry")}</Button>
    </div>
  );
}
