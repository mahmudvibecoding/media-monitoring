"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CheckCheckIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Fragment } from "react";

import { disagreementsOptions } from "@/api/@tanstack/react-query.gen";
import type { DisagreementText } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { lineFor, PageLink } from "@/components/page-link";
import { Pages } from "@/components/pages";
import { MISSED, MISTAKE, NAME_KINDS, NameMark, NameNotes, TelegramText } from "@/components/telegram-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { go } from "@/lib/address";
import { formatCount, pluralOf } from "@/lib/format";
import {
  type Difference,
  DIFFERENCES,
  disagreementsAddress,
  disagreementsQuery,
  type DisagreementsQuery as Query,
  type Platform,
  PLATFORMS,
} from "@/lib/names";
import { DIMMED } from "@/lib/pages";
import { chatPath } from "@/lib/telegram";
import { cn } from "@/lib/utils";
import { labelledPath } from "@/lib/youtube";

const SOURCES = ["gemma", "claude"] as const;

// The labelled texts where a model's names differ from those labelled by hand, Telegram's and YouTube's together, to
// review its mistakes: chips for whose names, where the texts are from and the kind of difference (each with how many
// texts it has); the texts, each with its channel, the way to its labelled page (where the hand's names are corrected),
// and the model's names marked as in the labelled chats: a mistake underlined red and wavy, a missed name framed and
// listed under the text. 50 to a page; the address keeps the choices and the page.
export function NameDisagreements() {
  const t = useTranslations("names");
  const labels = useTranslations("telegramChannel");
  const locale = useLocale();
  const query = disagreementsQuery(useSearchParams());
  const { data, error, isFetching, isPlaceholderData, refetch } = useQuery({
    ...disagreementsOptions({ query }),
    placeholderData: keepPreviousData,
  });
  const source = query.source ?? "gemma";
  const page = query.page ?? 1;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const choose = (changed: Partial<Query>) =>
    go(disagreementsAddress({ ...query, ...changed, page: undefined }), "push");
  const count = (n: number) => t("count", { count: pluralOf(n), formatted: formatCount(n, locale) });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Chips
          options={SOURCES.map((s) => ({ key: s, label: labels(`labellers.${s}`) }))}
          chosen={source}
          choose={(s) => choose({ source: s === "gemma" ? undefined : (s as Query["source"]) })}
        />
        <Chips
          options={[
            { key: "", label: t("all") },
            ...PLATFORMS.map((p) => ({ key: p, label: t(`platforms.${p}`), count: data?.platforms[p] ?? 0 })),
          ]}
          chosen={query.platform ?? ""}
          choose={(p) => choose({ platform: (p || undefined) as Platform | undefined })}
        />
        <Chips
          options={[
            { key: "", label: t("allDifferences") },
            ...DIFFERENCES.map((d) => ({ key: d, label: t(`differences.${d}`), count: data?.differences[d] ?? 0 })),
          ]}
          chosen={query.difference ?? ""}
          choose={(d) => choose({ difference: (d || undefined) as Difference | undefined })}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {NAME_KINDS.map((kind, index) => (
          <Fragment key={kind}>
            {index > 0 && " "}
            <NameMark kind={kind}>
              <span className="px-1">{labels(kind)}</span>
            </NameMark>
          </Fragment>
        ))}{" "}
        <span className={MISTAKE}>{labels("mistake")}</span>{" "}
        <span className={cn(MISSED, "rounded-[3px] border-tg-muted px-1")}>{labels("notFound")}</span>
      </p>
      {error && <ApiError error={error} retry={() => refetch()} retrying={isFetching} />}
      {!data && !error && (
        <div className="space-y-3" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      )}
      {data &&
        (data.total === 0 ? (
          <p className="text-muted-foreground">{t("none")}</p>
        ) : (
          <>
            <ul className={cn("space-y-3 transition-opacity", isPlaceholderData && DIMMED)}>
              {data.texts.map((text) => (
                <TextCard
                  key={`${text.platform}:${text.channel_id}:${text.message_id ?? text.video_id}:${text.comment_id}`}
                  text={text}
                  source={source}
                />
              ))}
            </ul>
            <Pages
              before={count(data.total)}
              page={page}
              pages={pages}
              turn={(to) => go(disagreementsAddress({ ...query, page: to > 1 ? to : undefined }), "push")}
            />
          </>
        ))}
    </div>
  );
}

// A row of chips, the chosen one dark, each with how many texts it has when that's known
function Chips({
  options,
  chosen,
  choose,
}: {
  options: { key: string; label: string; count?: number }[];
  chosen: string;
  choose: (key: string) => void;
}) {
  const locale = useLocale();
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          aria-pressed={option.key === chosen}
          onClick={() => option.key !== chosen && choose(option.key)}
          className={cn(
            "h-8 rounded-lg px-3 text-sm font-medium",
            option.key === chosen ? "bg-foreground text-background" : "bg-muted hover:bg-muted/70",
          )}
        >
          {option.label}
          {option.count !== undefined && (
            <span className="ml-1.5 tabular-nums opacity-70">{formatCount(option.count, locale)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// A text: where it's from, its channel (the way to its labelled page), the video a comment is under, the kinds of
// difference it has, ✓✓ when its names labelled by hand are marked checked; and the text with the model's names
function TextCard({ text, source }: { text: DisagreementText; source: "gemma" | "claude" }) {
  const t = useTranslations("names");
  const labels = useTranslations("telegramChannel");
  const href =
    text.platform === "telegram" ? chatPath(Number(text.channel_id), source) : labelledPath(text.channel_id, source);
  return (
    <li className="space-y-2 rounded-lg border bg-card p-4">
      <p className="flex flex-wrap items-center gap-x-1.5 text-sm wrap-anywhere text-muted-foreground">
        <span>{t(`platforms.${text.platform}`)}</span>
        <span aria-hidden="true">·</span>
        <PageLink href={href} line={lineFor(href)} className="font-medium text-foreground hover:underline">
          {text.channel_title?.trim() || text.channel_id}
        </PageLink>
        {text.platform === "youtube_comment" && text.video_title && (
          <>
            <span aria-hidden="true">·</span>
            <span className="line-clamp-1 wrap-anywhere">{text.video_title}</span>
          </>
        )}
        {text.checked_at && <CheckCheckIcon className="size-4 text-tg-checked" aria-label={labels("checked")} />}
        <span className="ml-auto">{text.differences.map((d) => t(`differences.${d}`)).join(", ")}</span>
      </p>
      <p className="text-sm leading-6 wrap-anywhere whitespace-pre-wrap">
        <TelegramText text={text.text.trimEnd()} names={text.names} raw />
        <NameNotes names={text.names} />
      </p>
    </li>
  );
}
