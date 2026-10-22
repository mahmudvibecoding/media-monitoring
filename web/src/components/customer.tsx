"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, KeyRoundIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

import {
  addPersonMutation,
  changeOrganizationMutation,
  changePersonMutation,
  organizationDetailsOptions,
  organizationDetailsQueryKey,
  organizationsQueryKey,
  resetPasswordMutation,
} from "@/api/@tanstack/react-query.gen";
import type { Person } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { StatusBadge } from "@/components/customers";
import { Projects } from "@/components/projects";
import { When } from "@/components/when";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { localeNames, locales } from "@/i18n/config";

type Locale = Person["locale"];

// One customer organization, for admins: its name (which can be changed), whether it's disabled (and the button that
// disables or enables it, which signs its people out at once), then its people, each of whom can be given a new
// temporary password or be disabled, and a form that adds one, then its projects. A temporary password, a new
// person's or a new one, shows once, above the people, to be passed on.
export function Customer({ id }: { id: number }) {
  const t = useTranslations("customers");
  const queryClient = useQueryClient();
  const path = { organization_id: id };
  const { data, error, refetch, isRefetching } = useQuery(organizationDetailsOptions({ path }));
  const [shown, setShown] = useState<{ name: string; password: string } | null>(null);

  // After any change: this organization anew, and the list of them (its count of people, its name, its state)
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: organizationDetailsQueryKey({ path }) }),
      queryClient.invalidateQueries({ queryKey: organizationsQueryKey() }),
    ]);

  if (error) return <ApiError error={error} retry={() => refetch()} retrying={isRefetching} />;
  if (!data) return null;
  return (
    <div className="space-y-8">
      <OrganizationHeader key={data.organization.name} id={id} organization={data.organization} refresh={refresh} />
      {shown && <TemporaryPassword {...shown} close={() => setShown(null)} />}
      <section className="space-y-4">
        <h2 className="font-semibold">{t("people")}</h2>
        {data.people.length === 0 ? (
          <p className="text-muted-foreground">{t("noPeople")}</p>
        ) : (
          <People people={data.people} refresh={refresh} show={setShown} />
        )}
        <AddPerson id={id} refresh={refresh} show={setShown} />
      </section>
      <Projects id={id} />
    </div>
  );
}

// The organization's name, as a heading or, being renamed, a form, with its state and the button that disables or
// enables it
function OrganizationHeader({
  id,
  organization,
  refresh,
}: {
  id: number;
  organization: { name: string; disabled: boolean };
  refresh: () => Promise<unknown>;
}) {
  const t = useTranslations("customers");
  const router = useRouter();
  const change = useMutation(changeOrganizationMutation());
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(organization.name);
  const path = { organization_id: id };

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await change.mutateAsync({ path, body: { name } }).catch(() => null)) {
      setRenaming(false);
      await refresh();
      router.refresh(); // the tab's title has the name too
    }
  }

  async function toggle() {
    const disabled = !organization.disabled;
    if (disabled && !window.confirm(t("confirmDisable", { name: organization.name }))) return;
    if (await change.mutateAsync({ path, body: { disabled } }).catch(() => null)) await refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {renaming ? (
          <form onSubmit={rename} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t("name")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              required
              autoFocus
              onFocus={(event) => event.currentTarget.select()} // typing replaces the name
              className="w-72 max-w-full"
            />
            <Button type="submit" disabled={change.isPending}>
              {t("save")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
              {t("cancel")}
            </Button>
          </form>
        ) : (
          <>
            <h1 className="text-lg font-semibold tracking-tight">{organization.name}</h1>
            <StatusBadge disabled={organization.disabled} />
            <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
              <PencilIcon />
              {t("rename")}
            </Button>
          </>
        )}
        <Button variant="outline" size="sm" className="ml-auto" disabled={change.isPending} onClick={toggle}>
          {t(organization.disabled ? "enable" : "disable")}
        </Button>
      </div>
      {change.error && <ApiError error={change.error} />}
    </div>
  );
}

// The organization's people, in the order they were added: who they are, their language, when they last signed in, and
// whether they still have a temporary password or are disabled; for each, a new temporary password, or disabling
function People({
  people,
  refresh,
  show,
}: {
  people: Person[];
  refresh: () => Promise<unknown>;
  show: (shown: { name: string; password: string }) => void;
}) {
  const t = useTranslations("customers");
  const change = useMutation(changePersonMutation());
  const reset = useMutation(resetPasswordMutation());

  async function toggle(person: Person) {
    const disabled = !person.disabled;
    if (disabled && !window.confirm(t("confirmDisablePerson", { name: person.name }))) return;
    if (await change.mutateAsync({ path: { person_id: person.id }, body: { disabled } }).catch(() => null)) {
      await refresh();
    }
  }

  async function newPassword(person: Person) {
    const given = await reset.mutateAsync({ path: { person_id: person.id } }).catch(() => null);
    if (!given) return;
    show({ name: person.name, password: given.password });
    await refresh();
  }

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("personName")}</TableHead>
            <TableHead>{t("email")}</TableHead>
            <TableHead>{t("language")}</TableHead>
            <TableHead>{t("lastSignIn")}</TableHead>
            <TableHead>{t("status")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {people.map((person) => (
            <TableRow key={person.id}>
              <TableCell className="font-medium">{person.name}</TableCell>
              <TableCell>{person.email}</TableCell>
              <TableCell>{localeNames[person.locale]}</TableCell>
              <TableCell className="tabular-nums">
                {person.last_sign_in_at ? <When iso={person.last_sign_in_at} /> : t("never")}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1.5">
                  <StatusBadge disabled={person.disabled} />
                  {person.must_change_password && !person.disabled && (
                    <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      {t("temporary")}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="sm" disabled={reset.isPending} onClick={() => newPassword(person)}>
                    <KeyRoundIcon />
                    {t("newPassword")}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={change.isPending} onClick={() => toggle(person)}>
                    {t(person.disabled ? "enable" : "disable")}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {change.error && <ApiError error={change.error} />}
      {reset.error && <ApiError error={reset.error} />}
    </div>
  );
}

// The form that adds a person: their name, email and language, the site's language at first. Their temporary password
// then shows above the people.
function AddPerson({
  id,
  refresh,
  show,
}: {
  id: number;
  refresh: () => Promise<unknown>;
  show: (shown: { name: string; password: string }) => void;
}) {
  const t = useTranslations("customers");
  const siteLocale = useLocale() as Locale;
  const add = useMutation(addPersonMutation());
  const [locale, setLocale] = useState<Locale>(siteLocale);
  const options = locales.map((value) => ({ value, label: localeNames[value] }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const body = { name: String(fields.get("name")), email: String(fields.get("email")), locale };
    const added = await add.mutateAsync({ path: { organization_id: id }, body }).catch(() => null);
    if (!added) return;
    form.reset();
    show({ name: added.person.name, password: added.password });
    await refresh();
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex flex-wrap items-start gap-2">
        <Input
          name="name"
          aria-label={t("personName")}
          placeholder={t("personName")}
          maxLength={200}
          required
          className="w-56"
        />
        <Input
          name="email"
          type="email"
          aria-label={t("email")}
          placeholder={t("email")}
          maxLength={254}
          autoComplete="off"
          required
          className="w-64"
        />
        <Select items={options} value={locale} onValueChange={(value) => setLocale(value as Locale)}>
          <SelectTrigger aria-label={t("language")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={add.isPending}>
          <PlusIcon />
          {t(add.isPending ? "adding" : "addPerson")}
        </Button>
      </form>
      {add.error && <ApiError error={add.error} />}
    </div>
  );
}

// A temporary password, shown this once, to be passed on: copied with a click
function TemporaryPassword({ name, password, close }: { name: string; password: string; close: () => void }) {
  const t = useTranslations("customers");
  const [copied, setCopied] = useState(false);
  return (
    <Alert>
      <KeyRoundIcon />
      <AlertTitle>{t("passwordFor", { name })}</AlertTitle>
      <AlertDescription className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 font-mono text-base text-foreground select-all">{password}</code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigator.clipboard.writeText(password).then(() => setCopied(true))}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {t(copied ? "copied" : "copy")}
          </Button>
          <Button variant="ghost" size="sm" onClick={close} aria-label={t("close")}>
            <XIcon />
          </Button>
        </div>
        <p>{t("passwordNote")}</p>
      </AlertDescription>
    </Alert>
  );
}
