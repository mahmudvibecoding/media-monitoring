import { getTranslations } from "next-intl/server";

import { ChangePasswordForm } from "@/components/change-password-form";
import { signedInUser } from "@/lib/api-server";
import { safeNext } from "@/lib/session";

// Changing one's own password: the only page a temporary password opens
export default async function ChangePassword({ searchParams }: PageProps<"/change-password">) {
  const t = await getTranslations("changePassword");
  const user = await signedInUser();
  const { next } = await searchParams;
  return (
    <div className="max-w-sm space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">{t("title")}</h1>
      {user?.must_change_password && <p className="text-muted-foreground">{t("required")}</p>}
      <ChangePasswordForm next={safeNext(typeof next === "string" ? next : undefined)} />
    </div>
  );
}
