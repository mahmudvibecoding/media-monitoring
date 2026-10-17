import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { Header } from "@/components/header";
import { SignInForm } from "@/components/sign-in-form";
import { signedInUser } from "@/lib/api-server";
import { safeNext } from "@/lib/session";

// Signing in, the one page anyone may open; afterwards, the page asked for (next), or the home page
export default async function SignIn({ searchParams }: PageProps<"/sign-in">) {
  const t = await getTranslations("signIn");
  const { next } = await searchParams;
  const target = safeNext(typeof next === "string" ? next : undefined);
  if (await signedInUser()) redirect(target); // already signed in
  return (
    <>
      <Header />
      <main className="mx-auto flex max-w-sm flex-col gap-6 px-6 py-16">
        <h1 className="text-lg font-semibold tracking-tight">{t("title")}</h1>
        <SignInForm next={target} />
      </main>
    </>
  );
}
