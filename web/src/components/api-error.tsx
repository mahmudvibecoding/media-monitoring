"use client";

import { RotateCwIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiFailure } from "@/lib/api-error";

// A failed request in the visitor's language: what happened, the request's ID when the API gave one (the same as in
// the API's log), and a button to ask again
export function ApiError({ error, retry, retrying }: { error: unknown; retry: () => void; retrying: boolean }) {
  const t = useTranslations("errors");
  const { code, requestId } = apiFailure(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>{t(code)}</AlertTitle>
      {requestId && <AlertDescription>{t("requestId", { id: requestId })}</AlertDescription>}
      <AlertAction>
        <Button variant="outline" size="sm" onClick={retry} disabled={retrying}>
          <RotateCwIcon className={retrying ? "animate-spin" : undefined} />
          {t("retry")}
        </Button>
      </AlertAction>
    </Alert>
  );
}
