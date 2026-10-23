"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheckIcon, CheckIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import {
  checkCommentMutation,
  checkVideoMutation,
  labelCommentMutation,
  labelVideoMutation,
  youtubeLabelledProgressOptions,
  youtubeLabelledTextsOptions,
  youtubeLabelledTextsQueryKey,
} from "@/api/@tanstack/react-query.gen";
import type { LabelledText, LabelledTexts } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { type NameStore, type Pick, useNameEditing, usePicking } from "@/components/name-labels";
import { MISSED, MISTAKE, NAME_KINDS, NameMark, NameNotes, TelegramText } from "@/components/telegram-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { CoverImage, YouTubeLink } from "@/components/youtube-ui";
import { formatCount } from "@/lib/format";
import { type Labeller, LABELLERS } from "@/lib/telegram";
import { cn } from "@/lib/utils";
import { labelledPath, thumbnail } from "@/lib/youtube";

const SAYING_FOR = 4000; // ms a note that a change wasn't saved stays, as YouTube's snackbar

// A channel's labelled texts (?labelled on its page), for admins to check as they check Telegram's: its videos' titles
// and descriptions and the comments under its videos, as name finders read them, with the names labelled by hand
// marked in them, or another labeller's (?labelled=gemma), compared with the hand's. With the hand's, a selection or a
// name picks it to be labelled (see name-labels.tsx), and the round button with ✓ beside a text marks it checked.
export function YouTubeLabelled({ id, labelled }: { id: string; labelled: Labeller }) {
  const t = useTranslations("telegramChannel");
  const youtube = useTranslations("youtubeChannel");
  const options = { path: { channel_id: id }, query: labelled === "hand" ? undefined : { source: labelled } };
  const key = youtubeLabelledTextsQueryKey(options);
  const { data, error, isFetching, refetch } = useQuery(youtubeLabelledTextsOptions(options));
  const queryClient = useQueryClient();
  const saveVideo = useMutation(labelVideoMutation());
  const saveComment = useMutation(labelCommentMutation());
  const markVideo = useMutation(checkVideoMutation());
  const markComment = useMutation(checkCommentMutation());
  const box = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), SAYING_FOR);
    return () => clearTimeout(timer);
  }, [note]);

  const find = (text: string) => queryClient.getQueryData<LabelledTexts>(key)?.texts.find((x) => keyOf(x) === text);
  function change(text: string, changed: Partial<LabelledText>) {
    queryClient.setQueryData<LabelledTexts>(key, (data) =>
      data ? { texts: data.texts.map((x) => (keyOf(x) === text ? { ...x, ...changed } : x)) } : data,
    );
  }
  const notSaved = () => setNote({ text: t("notSaved"), at: Date.now() });

  // The channel's other views (a model's) are read again when next shown
  const store: NameStore<string> = {
    find,
    show: (text, names) => change(text, { names }),
    save: (text, names, done) => {
      const [video = "", comment] = text.split("/");
      const body = { names: names.map(({ kind, start, end }) => ({ kind, start: start!, end: end! })) };
      const after = {
        onSuccess: (saved: LabelledText["names"]) => {
          done.onSuccess(saved);
          void queryClient.invalidateQueries({
            queryKey: [{ _id: "youtubeLabelledTexts", path: { channel_id: id } }],
            refetchType: "none",
          });
        },
        onError: done.onError,
      };
      if (comment) saveComment.mutate({ path: { video_id: video, comment_id: comment }, body }, after);
      else saveVideo.mutate({ path: { video_id: video }, body }, after);
    },
    failed: notSaved,
  };
  const area = useCallback(() => box.current, []);
  const editing = useNameEditing({ store, area, on: labelled === "hand" });

  // Marks a text checked, or not any more: at once, then saved; the channel list's counts and the progress are read
  // again
  function check(text: LabelledText) {
    const before = text.checked_at ?? null;
    change(keyOf(text), { checked_at: before ? null : new Date().toISOString() });
    const after = {
      onSuccess: (saved: { checked_at: string | null }) => {
        change(keyOf(text), { checked_at: saved.checked_at });
        void queryClient.invalidateQueries({ queryKey: [{ _id: "youtubeChannels" }] });
        void queryClient.invalidateQueries({ queryKey: [{ _id: "youtubeLabelledProgress" }] });
      },
      onError: () => {
        change(keyOf(text), { checked_at: before });
        notSaved();
      },
    };
    const body = { checked: !before };
    if (text.comment_id)
      markComment.mutate({ path: { video_id: text.video_id, comment_id: text.comment_id }, body }, after);
    else markVideo.mutate({ path: { video_id: text.video_id }, body }, after);
  }

  if (!data) {
    if (error) return <ApiError error={error} retry={() => void refetch()} retrying={isFetching} />;
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }
  return (
    <section className="space-y-3 font-roboto text-yt-text">
      <Legend id={id} labelled={labelled} texts={data.texts} />
      <div ref={box} className="relative space-y-3">
        {data.texts.length === 0 ? (
          <p className="text-sm text-yt-muted">{youtube("noneLabelled")}</p>
        ) : (
          data.texts.map((text) => (
            <TextCard
              key={keyOf(text)}
              text={text}
              onPick={editing.pick}
              onCheck={labelled === "hand" ? check : undefined}
            />
          ))
        )}
        {editing.toolbar}
      </div>
      {note && (
        <p
          key={note.at}
          role="status"
          className="fixed bottom-6 left-6 z-40 animate-in rounded-lg bg-yt-text px-4 py-3 text-sm text-white shadow-lg fade-in"
        >
          {note.text}
        </p>
      )}
    </section>
  );
}

const keyOf = (text: LabelledText) => `${text.video_id}/${text.comment_id ?? ""}`;

// Above the texts, as the labelled Telegram chats' card: whose names are marked (by hand, or a model's, compared with
// them); what the marks are; with the names labelled by hand, how many of the channel's texts are checked, of all of
// them, and the next channel to check; and the way to the channel's videos
function Legend({ id, labelled, texts }: { id: string; labelled: Labeller; texts: LabelledText[] }) {
  const t = useTranslations("telegramChannel");
  const youtube = useTranslations("youtubeChannel");
  const locale = useLocale();
  const progress = useQuery({
    ...youtubeLabelledProgressOptions({ query: { after: id } }),
    enabled: labelled === "hand",
  });
  const checked = texts.filter((x) => x.checked_at).length;
  return (
    <div className="space-y-1 rounded-xl bg-yt-chip px-4 py-3 text-sm leading-6">
      <p className="flex flex-wrap items-center gap-x-1">
        {t("namesBy")}
        {LABELLERS.map((labeller) => (
          <YouTubeLink
            key={labeller}
            href={labelledPath(id, labeller)}
            aria-current={labeller === labelled ? "page" : undefined}
            className={cn(
              "rounded-lg px-2.5 font-medium",
              labeller === labelled ? "bg-yt-text text-white" : "hover:bg-yt-chip-hover",
            )}
          >
            {t(`labellers.${labeller}`)}
          </YouTubeLink>
        ))}
      </p>
      <p>
        {NAME_KINDS.map((kind, index) => (
          <Fragment key={kind}>
            {index > 0 && " "}
            <NameMark kind={kind}>
              <span className="px-1">{t(kind)}</span>
            </NameMark>
          </Fragment>
        ))}
      </p>
      {labelled === "hand" ? (
        <>
          <p className="text-yt-muted">{t("editHint")}</p>
          <p>
            {t("checkedHere", { checked, total: texts.length })}
            {progress.data && (
              <>
                {" · "}
                {t("checkedAll", {
                  checked: formatCount(progress.data.checked, locale),
                  total: formatCount(progress.data.texts, locale),
                })}
              </>
            )}
            {progress.data?.next && (
              <>
                {" · "}
                <YouTubeLink href={labelledPath(progress.data.next, "hand")} className="text-yt-blue hover:underline">
                  {t("nextChannel")}
                </YouTubeLink>
              </>
            )}
          </p>
        </>
      ) : (
        <p>
          <span className={MISTAKE}>{t("mistake")}</span>{" "}
          <span className={cn(MISSED, "rounded-[3px] border-tg-muted px-1")}>{t("notFound")}</span>
        </p>
      )}
      <YouTubeLink href={`/youtube/channels/${id}`} className="text-yt-blue hover:underline">
        {youtube("allVideos")}
      </YouTubeLink>
    </div>
  );
}

// A labelled text: the video's cover, opening it here, whether it's a video's title and description, a Short's, or a
// comment under the video (with its title), and the text as name finders read it, its names marked, and under it the
// names a model missed, or that it has none; with onCheck, the round button with ✓ at its right marks it checked
function TextCard({
  text,
  onPick,
  onCheck,
}: {
  text: LabelledText;
  onPick?: Pick<string>;
  onCheck?: (text: LabelledText) => void;
}) {
  const t = useTranslations("telegramChannel");
  const youtube = useTranslations("youtubeChannel");
  const box = useRef<HTMLParagraphElement>(null);
  const picking = usePicking(box, keyOf(text), text.text, text.names, onPick);
  const href = text.kind === "short" ? `/youtube/shorts/${text.video_id}` : `/youtube/videos/${text.video_id}`;
  return (
    <article className="flex items-start gap-3 rounded-xl border border-yt-divider p-3">
      <YouTubeLink href={href} prefetch={false} className="hidden shrink-0 sm:block" tabIndex={-1} aria-hidden="true">
        <CoverImage
          sources={[thumbnail(text.video_id)]}
          className="aspect-video w-40 rounded-lg bg-yt-chip object-cover"
        />
      </YouTubeLink>
      <div className="min-w-0 flex-1">
        <p className="mb-1 truncate text-xs leading-[18px] text-yt-muted">
          {youtube(`labelledKinds.${text.kind}`)}
          {text.kind === "comment" && text.video_title && (
            <>
              {": "}
              <YouTubeLink href={href} prefetch={false} className="hover:underline">
                {text.video_title}
              </YouTubeLink>
            </>
          )}
          {onCheck && text.checked_at && (
            <CheckCheckIcon className="ml-1 inline size-4 align-[-3px] text-tg-checked" aria-label={t("checked")} />
          )}
        </p>
        <p
          ref={box}
          {...picking}
          className={cn(
            "text-sm leading-5 break-words whitespace-pre-wrap",
            onPick && "[&_mark[data-name]]:cursor-pointer",
          )}
        >
          <TelegramText text={text.text.trimEnd()} names={text.names} raw />
          <NameNotes names={text.names} />
        </p>
      </div>
      {onCheck && (
        <button
          type="button"
          onClick={() => onCheck(text)}
          aria-pressed={!!text.checked_at}
          aria-label={text.checked_at ? t("uncheck") : t("check")}
          title={text.checked_at ? t("uncheck") : t("check")}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center self-center rounded-full transition-colors",
            text.checked_at ? "bg-tg-checked text-white" : "bg-yt-chip text-yt-muted hover:text-tg-checked",
          )}
        >
          <CheckIcon className="size-5" strokeWidth={2.5} />
        </button>
      )}
    </article>
  );
}
