"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

import { changePasswordMutation } from "@/api/@tanstack/react-query.gen";
import { ApiError } from "@/components/api-error";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Changes the signed-in user's password (the API checks the rules too), then goes on to next
export function ChangePasswordForm({ next }: { next: string }) {
  const t = useTranslations("changePassword");
  const change = useMutation(changePasswordMutation());
  const [mismatch, setMismatch] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = { current: String(form.get("current")), new: String(form.get("new")) };
    setMismatch(body.new !== String(form.get("repeat")));
    if (body.new !== String(form.get("repeat"))) return;
    const changed = await change.mutateAsync({ body }).then(
      () => true,
      () => false, // change.error shows what failed
    );
    if (changed) window.location.assign(next);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="current">{t("current")}</Label>
        <Input id="current" name="current" type="password" autoComplete="current-password" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="new">{t("new")}</Label>
        <Input id="new" name="new" type="password" autoComplete="new-password" minLength={10} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="repeat">{t("repeat")}</Label>
        <Input id="repeat" name="repeat" type="password" autoComplete="new-password" minLength={10} required />
      </div>
      <p className="text-sm text-muted-foreground">{t("rules")}</p>
      {mismatch && (
        <Alert variant="destructive">
          <AlertTitle>{t("mismatch")}</AlertTitle>
        </Alert>
      )}
      {change.error && <ApiError error={change.error} />}
      <Button type="submit" disabled={change.isPending} className="w-full">
        {t(change.isPending ? "submitting" : "submit")}
      </Button>
    </form>
  );
}
