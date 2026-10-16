"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { FormEvent } from "react";

import { signInMutation } from "@/api/@tanstack/react-query.gen";
import { ApiError } from "@/components/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adoptLocale } from "@/i18n/actions";

// Signs in, settles the language (see adoptLocale), and goes on: to the password change first, if the password
// is temporary, then to next. The page loads anew, so it's rendered for the account.
export function SignInForm({ next }: { next: string }) {
  const t = useTranslations("signIn");
  const signIn = useMutation(signInMutation());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = { email: String(form.get("email")), password: String(form.get("password")) };
    const user = await signIn.mutateAsync({ body }).catch(() => null); // signIn.error shows what failed
    if (!user) return;
    await adoptLocale(user.locale);
    window.location.assign(user.must_change_password ? `/change-password?next=${encodeURIComponent(next)}` : next);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">{t("password")}</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {signIn.error && <ApiError error={signIn.error} />}
      <Button type="submit" disabled={signIn.isPending} className="w-full">
        {t(signIn.isPending ? "submitting" : "submit")}
      </Button>
    </form>
  );
}
