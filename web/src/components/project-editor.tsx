"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import {
  addProjectMutation,
  changeProjectMutation,
  projectDetailsQueryKey,
  projectsQueryKey,
} from "@/api/@tanstack/react-query.gen";
import { previewProject } from "@/api/sdk.gen";
import type { Mention, Preview, Project, SourcePreview } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { StatusBadge } from "@/components/customers";
import { PageLink } from "@/components/page-link";
import { When } from "@/components/when";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatCount } from "@/lib/format";

const ASK_AFTER = 600; // milliseconds after the last change the preview asks again
const HAS_WORDS = /[\p{L}\p{N}]/u; // a keyword finds something only with a letter or a digit

// A box's lines, each without spaces around it, empty ones dropped
function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// The first line (counted from 1) with nothing to find, or null
function wordless(text: string): number | null {
  const index = text.split("\n").findIndex((line) => line.trim() !== "" && !HAS_WORDS.test(line));
  return index < 0 ? null : index + 1;
}

// A project's page, for admins: its name, keywords and exclusions in a form, and beside it what they find in the last
// 30 days, asked again a moment after each change (a preview, which saves nothing). Saving adds the project, or
// changes it, and goes back to its organization; an existing one can also be disabled or enabled.
export function ProjectEditor({ organizationId, project }: { organizationId: number; project?: Project }) {
  const t = useTranslations("projects");
  const router = useRouter();
  const queryClient = useQueryClient();
  const add = useMutation(addProjectMutation());
  const change = useMutation(changeProjectMutation());
  const [name, setName] = useState(project?.name ?? "");
  const [keywordsText, setKeywordsText] = useState(project?.keywords.join("\n") ?? "");
  const [exclusionsText, setExclusionsText] = useState(project?.exclusions.join("\n") ?? "");
  const [asked, setAsked] = useState({ keywords: lines(keywordsText), exclusions: lines(exclusionsText) });
  const badKeyword = wordless(keywordsText);
  const badExclusion = wordless(exclusionsText);

  useEffect(() => {
    const timer = setTimeout(
      () => setAsked({ keywords: lines(keywordsText), exclusions: lines(exclusionsText) }),
      ASK_AFTER,
    );
    return () => clearTimeout(timer);
  }, [keywordsText, exclusionsText]);

  const askable =
    asked.keywords.length > 0 && [...asked.keywords, ...asked.exclusions].every((line) => HAS_WORDS.test(line));
  const preview = useQuery({
    queryKey: ["projectPreview", asked],
    queryFn: async ({ signal }) => (await previewProject({ body: asked, signal, throwOnError: true })).data,
    enabled: askable,
    placeholderData: keepPreviousData, // the last preview stays while the next is on its way
    staleTime: 5 * 60_000,
    retry: false,
  });

  const saving = add.isPending || change.isPending;
  const failed = add.error ?? change.error;

  // After a change: the organization's projects, and this one
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: projectsQueryKey({ path: { organization_id: organizationId } }) }),
      project &&
        queryClient.invalidateQueries({ queryKey: projectDetailsQueryKey({ path: { project_id: project.id } }) }),
    ]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = { name, keywords: lines(keywordsText), exclusions: lines(exclusionsText) };
    const saved = project
      ? await change.mutateAsync({ path: { project_id: project.id }, body }).catch(() => null)
      : await add.mutateAsync({ path: { organization_id: organizationId }, body }).catch(() => null);
    if (!saved) return; // the error shows above the buttons
    await refresh();
    router.push(`/users/${organizationId}`);
  }

  async function toggle() {
    if (!project) return;
    const disabled = !project.disabled;
    if (disabled && !window.confirm(t("confirmDisable", { name: project.name }))) return;
    if (await change.mutateAsync({ path: { project_id: project.id }, body: { disabled } }).catch(() => null)) {
      await refresh();
      router.refresh(); // the page's project, with its new state
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <form onSubmit={save} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="project-name">{t("name")}</Label>
          <Input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("namePlaceholder")}
            maxLength={200}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="project-keywords">{t("keywords")}</Label>
          <Textarea
            id="project-keywords"
            value={keywordsText}
            onChange={(event) => setKeywordsText(event.target.value)}
            aria-invalid={badKeyword !== null || undefined}
            className="min-h-40"
            required
          />
          {badKeyword !== null && <p className="text-xs text-destructive">{t("noWords", { line: badKeyword })}</p>}
          <p className="text-xs text-muted-foreground">{t("keywordsHint")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="project-exclusions">{t("exclusions")}</Label>
          <Textarea
            id="project-exclusions"
            value={exclusionsText}
            onChange={(event) => setExclusionsText(event.target.value)}
            aria-invalid={badExclusion !== null || undefined}
            className="min-h-24"
          />
          {badExclusion !== null && <p className="text-xs text-destructive">{t("noWords", { line: badExclusion })}</p>}
          <p className="text-xs text-muted-foreground">{t("exclusionsHint")}</p>
        </div>
        {failed && <ApiError error={failed} />}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={saving}>
            {t(saving ? "saving" : "save")}
          </Button>
          <PageLink href={`/users/${organizationId}`} className={buttonVariants({ variant: "ghost" })}>
            {t("cancel")}
          </PageLink>
          {project && (
            <>
              <span className="ml-auto">
                <StatusBadge disabled={project.disabled} />
              </span>
              <Button type="button" variant="outline" disabled={saving} onClick={toggle}>
                {t(project.disabled ? "enable" : "disable")}
              </Button>
            </>
          )}
        </div>
      </form>
      <PreviewPanel
        idle={!askable}
        preview={preview.data}
        error={preview.error}
        fetching={preview.isFetching}
        retry={() => preview.refetch()}
      />
    </div>
  );
}

// What the keywords find: each kind of text with how many matched, as tabs, and the chosen kind's newest examples
function PreviewPanel({
  idle,
  preview,
  error,
  fetching,
  retry,
}: {
  idle: boolean;
  preview?: Preview;
  error: unknown;
  fetching: boolean;
  retry: () => void;
}) {
  const t = useTranslations("projects");
  const locale = useLocale();
  const [chosen, setChosen] = useState<SourcePreview["source"]>("telegram");
  const source = preview?.sources.find((each) => each.source === chosen);
  let body: ReactNode;
  if (idle) body = <p className="text-muted-foreground">{t("previewHint")}</p>;
  else if (error) body = <ApiError error={error} retry={retry} retrying={fetching} />;
  else if (!preview) body = <PreviewLoading />;
  else
    body = (
      <>
        <div className="flex flex-wrap gap-1" role="tablist">
          {preview.sources.map((each) => (
            <Button
              key={each.source}
              type="button"
              role="tab"
              aria-selected={each.source === chosen}
              variant={each.source === chosen ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setChosen(each.source)}
            >
              {t(each.source)}
              <span className="text-muted-foreground tabular-nums">
                {each.more_than
                  ? t("more", { count: formatCount(each.more_than, locale) })
                  : formatCount(each.count, locale)}
              </span>
            </Button>
          ))}
        </div>
        {source &&
          (source.examples.length === 0 ? (
            <p className="text-muted-foreground">{t("noMatches")}</p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {source.examples.map((mention, index) => (
                <Example key={`${mention.url}-${index}`} mention={mention} />
              ))}
            </ul>
          ))}
      </>
    );
  return (
    <section className="min-w-0 space-y-4 lg:sticky lg:top-6 lg:self-start">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">{t("preview")}</h2>
        {fetching && !idle && <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />}
      </div>
      {body}
    </section>
  );
}

function PreviewLoading() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-7 w-80 max-w-full" />
      {[0, 1, 2].map((key) => (
        <Skeleton key={key} className="h-20 w-full" />
      ))}
    </div>
  );
}

// One text the keywords found: who wrote it and when, the text with its keywords marked, and where it is. The picture
// is a plain circle without one, or when it doesn't load (Telegram's own link to a photo not saved yet lasts less than
// two days).
function Example({ mention }: { mention: Mention }) {
  const t = useTranslations("projects");
  const [broken, setBroken] = useState(false);
  const external = mention.url.startsWith("http");
  return (
    <li className="flex gap-3 p-3">
      {mention.image && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={mention.image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          className="size-9 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="size-9 shrink-0 rounded-full bg-muted" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2 text-sm">
          <span className="truncate font-medium">{mention.title}</span>
          {mention.author && <span className="truncate text-muted-foreground">{mention.author}</span>}
          {mention.published_at && (
            <When iso={mention.published_at} className="ml-auto shrink-0 text-xs text-muted-foreground" />
          )}
        </div>
        <Marked text={mention.text} highlights={mention.highlights} />
        {external ? (
          <a
            href={mention.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("open")}
            <ExternalLinkIcon className="size-3" />
          </a>
        ) : (
          <PageLink href={mention.url} className="text-xs text-muted-foreground hover:text-foreground">
            {t("open")}
          </PageLink>
        )}
      </div>
    </li>
  );
}

// A text with its keywords marked: each highlight is a match's start and end, counted as the browser counts letters
function Marked({ text, highlights }: { text: string; highlights: Array<[number, number]> }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of highlights) {
    if (start < at) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="rounded-sm bg-amber-100 px-0.5 text-amber-950">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  parts.push(text.slice(at));
  return <p className="text-sm break-words whitespace-pre-line">{parts}</p>;
}
