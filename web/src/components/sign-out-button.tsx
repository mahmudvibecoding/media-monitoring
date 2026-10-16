"use client";

import { useMutation } from "@tanstack/react-query";
import { LogOutIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { signOutMutation } from "@/api/@tanstack/react-query.gen";
import { Button } from "@/components/ui/button";

// Ends the session, then loads the sign-in page anew, which also drops whatever this tab kept of the account's data
export function SignOutButton() {
  const t = useTranslations("header");
  const signOut = useMutation(signOutMutation());
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={signOut.isPending}
      // A full load, not Next's router: it drops all that the tab kept of the account
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      onClick={() => signOut.mutate({}, { onSettled: () => window.location.assign("/sign-in") })}
    >
      <LogOutIcon />
      {t("signOut")}
    </Button>
  );
}
