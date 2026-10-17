"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  HeartIcon,
  MessageSquareIcon,
  PauseIcon,
  PlayIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";

import {
  youtubeChannelOptions,
  youtubeChannelVideosInfiniteOptions,
  youtubeVideoOptions,
} from "@/api/@tanstack/react-query.gen";
import type { YouTubeChannelDetails, YouTubeVideo } from "@/api/types.gen";
import { CommentList } from "@/components/youtube-comments";
import {
  BUFFERING,
  command,
  embed,
  ENDED,
  Hush,
  PLAYING,
  scaled,
  useEmbedded,
  useHush,
} from "@/components/youtube-embed";
import { ShortsGhost } from "@/components/youtube-ghosts";
import { ShareButton } from "@/components/youtube-share";
import { YouTubeText } from "@/components/youtube-text";
import { ChannelPicture, CoverImage, ShareIcon, YouTubeLink, YT_ICON_BUTTON } from "@/components/youtube-ui";
import { formatCompact, formatCount, formatYouTubeDay } from "@/lib/format";
import { FIRST_PAGE, nextPage } from "@/lib/pages";
import { cn } from "@/lib/utils";
import { type Sort, thumbnail, uprightThumbnail } from "@/lib/youtube";

const AHEAD = 3; // Shorts left in the feed when the next page of the list is asked for
const LOOK_FOR = 6; // pages of the channel's Shorts looked through for the one opened, when it isn't on the first
const SETTLED = 150; // milliseconds without scrolling after which the feed is at rest (where scrollend isn't known)
const TOP = 8; // px between YouTube's top bar and a Short at rest

type PanelKind = "comments" | "description";

// A Short's page, as YouTube's Shorts: a feed that slides up and down, a Short to a screen, each upright in the middle
// with the channel and the title over its bottom, YouTube's round buttons beside it (the likes, the comments, which open
// their panel beside the feed, and Share), and the next one's top showing under it. The feed is the Short opened, then
// those after it among the channel's Shorts, in the order of the grid it was opened from (the address's ?sort=…, newest
// first without it), as YouTube's is; it loads on as it's scrolled. It's the browser's own scrolling, snapped to one
// Short at a time, so the wheel, a two-finger swipe and a finger slide it, smoothly, as on YouTube; ↑ and ↓ and the
// arrows at the right slide it a Short at a time. The Short the feed comes to rest on is the one playing: its player is
// loaded (once the feed is at rest, so nothing heavy happens while it slides), the others show their pictures, and the
// address and the tab's title change to it, in place (as YouTube's, without a step in the history: Back goes back to
// where the Shorts were opened from). Each Short's details are asked for as it comes.
export function ShortsPage({ id: opened }: { id: string }) {
  const t = useTranslations("youtube");
  const common = useTranslations("common");
  const site = useTranslations("metadata");
  const asked = useSearchParams().get("sort");
  const [sort] = useState<Sort | undefined>(asked === "popular" || asked === "oldest" ? asked : undefined); // the page's
  const first = useQuery(youtubeVideoOptions({ path: { video_id: opened } })).data;
  const channelId = first?.channel_id;
  const channel = useQuery({
    ...youtubeChannelOptions({ path: { channel_id: channelId ?? "" } }),
    enabled: !!channelId,
  }).data;
  const list = useInfiniteQuery({
    ...youtubeChannelVideosInfiniteOptions({
      path: { channel_id: channelId ?? "" },
      query: sort ? { kind: "short", sort } : { kind: "short" },
    }),
    ...FIRST_PAGE,
    getNextPageParam: nextPage("videos"),
    enabled: !!channelId,
  });
  const shorts = list.data?.pages.flatMap((page) => page.videos) ?? [];
  const at = shorts.findIndex((short) => short.id === opened);
  const feed: YouTubeVideo[] = at >= 0 ? shorts.slice(at) : first ? [first] : []; // the opened one alone till found
  const [active, setActive] = useState(0);
  const current = feed[Math.min(active, feed.length - 1)];
  const details = useQuery({
    ...youtubeVideoOptions({ path: { video_id: current?.id ?? opened } }),
    enabled: !!current,
  }).data;
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // The list loads on: further pages while the opened Short isn't on those loaded (a few at most), and the next one as
  // the feed's end comes near
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const loaded = list.data?.pages.length ?? 0;
  const wanted =
    !!hasNextPage &&
    !isFetchingNextPage &&
    ((at < 0 && loaded < LOOK_FOR) || (at >= 0 && active >= feed.length - AHEAD));
  useEffect(() => {
    if (wanted) void fetchNextPage();
  }, [wanted, fetchNextPage]);

  // The Short playing is the one the feed comes to rest on: the one whose top is nearest its place under the top bar
  // (followed from the time the feed is there)
  const ready = !!first && !!current;
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rest = () => {
      clearTimeout(timer);
      let [nearest, distance] = [0, Infinity];
      box.querySelectorAll<HTMLElement>("[data-reel]").forEach((reel, index) => {
        const off = Math.abs(reel.offsetTop - TOP - box.scrollTop);
        if (off < distance) [nearest, distance] = [index, off];
      });
      setActive(nearest);
    };
    const scrolled = () => {
      clearTimeout(timer);
      timer = setTimeout(rest, SETTLED);
    };
    box.addEventListener("scroll", scrolled, { passive: true });
    box.addEventListener("scrollend", rest);
    return () => {
      clearTimeout(timer);
      box.removeEventListener("scroll", scrolled);
      box.removeEventListener("scrollend", rest);
    };
  }, [ready]);

  // The address and the tab's title follow it, in place
  const currentId = current?.id;
  const title = current?.title?.trim() || currentId || opened;
  useEffect(() => {
    if (currentId && window.location.pathname !== `/youtube/shorts/${currentId}`) {
      window.history.replaceState(null, "", `/youtube/shorts/${currentId}${window.location.search}`);
    }
  }, [currentId]);
  useEffect(() => {
    document.title = `${title} · ${site("title")}`;
  }, [title, site]);

  // Slides the feed to a Short, smoothly
  function slide(to: number) {
    const box = scroller.current;
    const reel = box?.querySelector<HTMLElement>(`[data-reel="${to}"]`);
    if (box && reel) box.scrollTo({ top: reel.offsetTop - TOP, behavior: "smooth" });
  }

  // ↑ and ↓ slide it a Short at a time, unless one's typing somewhere
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || target.isContentEditable) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const box = scroller.current;
      const reel = box?.querySelector<HTMLElement>(`[data-reel="${active + step}"]`);
      if (box && reel) box.scrollTo({ top: reel.offsetTop - TOP, behavior: "smooth" });
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active]);

  // A Short's buttons open (or close) a panel for it, sliding to it first if it isn't the one playing
  function open(index: number, which: PanelKind) {
    if (index !== active) slide(index);
    setPanel(index === active && panel === which ? null : which);
  }

  if (!first || !current) return <ShortsGhost label={common("loading")} />;
  return (
    <div className="flex h-[calc(100svh-3.5rem)] font-roboto text-yt-text">
      <div
        ref={scroller}
        className="relative h-full min-w-0 flex-1 snap-y snap-mandatory scroll-pt-2 [scrollbar-width:none] overflow-y-scroll overscroll-contain px-4 pt-2 pb-6 [&::-webkit-scrollbar]:hidden"
      >
        {feed.map((video, index) => (
          <Reel
            key={video.id}
            index={index}
            video={video}
            channel={channel}
            active={index === active}
            panel={index === active ? panel : null}
            open={(which) => open(index, which)}
          />
        ))}
      </div>
      {panel && (
        <Panel
          title={panel === "comments" ? t("comments") : t("description")}
          count={panel === "comments" ? details?.comments_collected : undefined}
          close={() => setPanel(null)}
        >
          {(panelScroller) =>
            panel === "comments" ? (
              <CommentList key={current.id} id={current.id} owner={channelId} scroller={panelScroller} />
            ) : (
              <About video={current} description={details?.description ?? null} channel={channel} />
            )
          }
        </Panel>
      )}
      <div className="hidden w-20 shrink-0 flex-col items-center justify-center gap-4 md:flex">
        <button
          type="button"
          onClick={() => slide(active - 1)}
          disabled={active <= 0}
          aria-label={t("previous")}
          className="flex size-14 items-center justify-center rounded-full bg-yt-chip hover:bg-yt-chip-hover disabled:invisible"
        >
          <ArrowUpIcon className="size-6" />
        </button>
        <button
          type="button"
          onClick={() => slide(active + 1)}
          disabled={active >= feed.length - 1}
          aria-label={t("next")}
          className="flex size-14 items-center justify-center rounded-full bg-yt-chip hover:bg-yt-chip-hover disabled:invisible"
        >
          <ArrowDownIcon className="size-6" />
        </button>
      </div>
    </div>
  );
}

// A Short in the feed: a screen's height (but for the space above it and the next one's top under it), a place the
// feed's scrolling stops at, never passed by a single swipe; its picture in YouTube's upright frame with the channel
// and the title over its bottom, and, while it's the one playing, its player over the picture; and its buttons beside it
function Reel({
  index,
  video,
  channel,
  active,
  panel,
  open,
}: {
  index: number;
  video: YouTubeVideo;
  channel?: YouTubeChannelDetails;
  active: boolean;
  panel: PanelKind | null;
  open: (which: PanelKind) => void;
}) {
  const name = channel?.handle ?? (channel?.title?.trim() || "");
  return (
    <section
      data-reel={index}
      aria-label={video.title?.trim() || video.id}
      className="relative mb-4 flex h-[calc(100svh-6rem)] snap-start snap-always items-center justify-center gap-3 sm:items-end"
    >
      <div
        className="group/short relative h-full shrink overflow-hidden rounded-xl bg-black"
        style={{ aspectRatio: "9 / 16", maxHeight: "calc((100vw - 32px) * 16 / 9)" }}
      >
        <CoverImage
          sources={[uprightThumbnail(video.id), thumbnail(video.id, "hq")]}
          className="absolute inset-0 size-full object-cover"
        />
        {active && <ShortPlayer video={video} />}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/60 via-black/25 to-transparent px-3 pt-20 pb-5 text-white max-sm:pr-16">
          {channel && (
            <YouTubeLink
              href={`/youtube/channels/${channel.id}`}
              className="pointer-events-auto flex w-fit max-w-full items-center gap-2 text-sm leading-5 font-medium"
            >
              <ChannelPicture url={channel.avatar_url} size={32} />
              <span className="truncate">{name}</span>
            </YouTubeLink>
          )}
          <button
            type="button"
            onClick={() => open("description")}
            className="pointer-events-auto mt-2 line-clamp-2 text-left text-sm leading-5 break-words"
          >
            {video.title?.trim() || video.id}
          </button>
        </div>
      </div>
      <Actions video={video} panel={panel} open={open} />
    </section>
  );
}

// What the player last told about itself; started once it has played, which the picture shows until
type State = { playing: boolean; muted: boolean; time: number; duration: number; started: boolean };
const SCALE = 4; // the player is drawn four times as big as the frame and shrunk back (see youtube-embed)
const CROP = 160; // px of the player above and below the frame

// The Short playing, by YouTube's player over its picture, with the page's own controls, as YouTube's Shorts have them:
// a click on it plays and pauses (K and the space bar too), a big play sign shows while it's paused, the play and sound
// buttons at its top left come under the mouse (M mutes), and the red line along its bottom says where it's at and goes
// where it's clicked; at its end it starts again. The picture shows until the Short has started, so sliding to it
// doesn't go black. The player is 160 px taller than the frame at each end, so what YouTube puts along them (the
// title, its logo, and for a Short its own like count) falls outside it, while the Short, as wide as the frame, fills
// it; and it's drawn four times as big and shrunk back, with a blur over the middle while YouTube's own ⏸ is there
// (see youtube-embed). The player is loaded only once its page shows, and unloaded as it goes.
function ShortPlayer({ video }: { video: YouTubeVideo }) {
  const t = useTranslations("youtube");
  const [state, setState] = useState<State>({
    playing: true,
    muted: false,
    time: 0,
    duration: video.duration ?? 0,
    started: false,
  });
  const [hushed, hush] = useHush();
  const last = useRef(state); // the same, for the handlers
  useEffect(() => {
    last.current = state;
  });
  const frame = useEmbedded(
    video.id,
    () => embed(video.id, { from: last.current.time }), // from the start, or from where it was
    (info, answer) => {
      if (info.playerState === ENDED) {
        // Round again, as YouTube's Shorts play
        hush();
        answer("seekTo", [0, true]);
        answer("playVideo");
      }
      if (info.playerState === PLAYING && !last.current.started) hush();
      setState((now) => ({
        playing:
          typeof info.playerState === "number"
            ? [PLAYING, BUFFERING, ENDED].includes(info.playerState) // at its end, it goes round again at once
            : now.playing,
        muted: typeof info.muted === "boolean" ? info.muted : now.muted,
        time: typeof info.currentTime === "number" ? info.currentTime : now.time,
        duration: typeof info.duration === "number" && info.duration > 0 ? info.duration : now.duration,
        started: now.started || info.playerState === PLAYING,
      }));
    },
  );
  const send = (func: string, args: unknown[] = []) => command(frame.current, func, args);
  const toggle = () => {
    if (!last.current.playing) hush(); // going on, YouTube shows its ⏸ again
    send(last.current.playing ? "pauseVideo" : "playVideo");
  };
  const mute = () => {
    send(last.current.muted ? "unMute" : "mute");
    setState((now) => ({ ...now, muted: !now.muted }));
  };
  const seek = (seconds: number) => {
    hush();
    send("seekTo", [seconds, true]);
    setState((now) => ({ ...now, time: seconds }));
  };

  // K and the space bar play and pause, M mutes, unless one's typing somewhere (the space bar presses a button that has
  // the focus)
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || target.isContentEditable) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === " " && ["BUTTON", "A"].includes(target.tagName)) return;
      if (event.key === " " || event.key === "k") toggle();
      else if (event.key === "m") mute();
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  return (
    <>
      <iframe
        ref={frame}
        src="about:blank"
        title={video.title ?? video.id}
        allow="autoplay; encrypted-media; picture-in-picture; web-share"
        tabIndex={-1}
        style={scaled(SCALE, CROP)}
        className={cn(
          "pointer-events-none absolute max-w-none transition-opacity duration-300",
          state.started ? "opacity-100" : "opacity-0",
        )}
      />
      {hushed && state.started && <Hush size={30} />}
      <button
        type="button"
        onClick={toggle}
        aria-label={state.playing ? t("pause") : t("play")}
        className="absolute inset-0 flex items-center justify-center"
      >
        {!state.playing && (
          <span className="flex size-16 items-center justify-center rounded-full bg-black/40 text-white">
            <PlayIcon className="size-8 fill-white" />
          </span>
        )}
      </button>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex gap-1 bg-linear-to-b from-black/40 to-transparent p-3 pb-8 opacity-0 transition-opacity group-hover/short:opacity-100">
        <button
          type="button"
          onClick={toggle}
          aria-label={state.playing ? t("pause") : t("play")}
          className="pointer-events-auto flex size-10 items-center justify-center rounded-full text-white hover:bg-white/10"
        >
          {state.playing ? <PauseIcon className="size-6 fill-white" /> : <PlayIcon className="size-6 fill-white" />}
        </button>
        <button
          type="button"
          onClick={mute}
          aria-label={state.muted ? t("unmute") : t("mute")}
          className="pointer-events-auto flex size-10 items-center justify-center rounded-full text-white hover:bg-white/10"
        >
          {state.muted ? <VolumeXIcon className="size-6" /> : <Volume2Icon className="size-6" />}
        </button>
      </div>
      <Progress state={state} seek={seek} />
    </>
  );
}

// The red line along the bottom, where the Short is at: between the player's reports, it moves on by itself while the
// Short plays; under the mouse it's thicker, and a click takes the Short there
function Progress({ state, seek }: { state: State; seek: (seconds: number) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const from = performance.now();
    const tick = () => {
      const now = state.playing ? state.time + (performance.now() - from) / 1000 : state.time;
      if (bar.current && state.duration > 0) {
        bar.current.style.transform = `scaleX(${Math.min(1, (now % state.duration) / state.duration)})`;
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [state.playing, state.time, state.duration]);
  return (
    <div
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        if (state.duration > 0) seek(((event.clientX - box.left) / box.width) * state.duration);
      }}
      className="absolute inset-x-0 bottom-0 flex h-3 cursor-pointer items-end"
    >
      <div className="h-1 w-full bg-white/30 transition-[height] group-hover/short:h-1.5">
        <div ref={bar} className="h-full origin-left bg-yt-red" style={{ transform: "scaleX(0)" }} />
      </div>
    </div>
  );
}

// YouTube's round buttons beside a Short, each with its label under it: the likes (which only show here), the
// comments, which open their panel (and close it again), and Share. On a phone they're over the Short's right side,
// white, as in YouTube's app.
function Actions({
  video,
  panel,
  open,
}: {
  video: YouTubeVideo;
  panel: PanelKind | null;
  open: (which: PanelKind) => void;
}) {
  const t = useTranslations("youtube");
  const videoTexts = useTranslations("youtubeVideo");
  const locale = useLocale();
  const round = "flex size-12 items-center justify-center rounded-full bg-yt-chip max-sm:bg-black/30 max-sm:text-white";
  return (
    <div className="flex shrink-0 flex-col items-center gap-4 max-sm:absolute max-sm:right-2 max-sm:bottom-24">
      <Labeled label={video.likes === null ? videoTexts("like") : formatCompact(video.likes, locale, true)}>
        <span
          className={round}
          title={video.likes === null ? undefined : `${videoTexts("likes")}: ${formatCount(video.likes, locale)}`}
        >
          <HeartIcon className="size-6" />
        </span>
      </Labeled>
      <Labeled label={video.comments === null ? t("comments") : formatCompact(video.comments, locale, true)}>
        <button
          type="button"
          onClick={() => open("comments")}
          aria-label={t("comments")}
          aria-pressed={panel === "comments"}
          className={cn(round, "hover:bg-yt-chip-hover max-sm:hover:bg-black/40")}
        >
          <MessageSquareIcon className="size-6" />
        </button>
      </Labeled>
      <ShareButton
        id={video.id}
        short
        look={({ open: share, label }) => (
          <Labeled label={label}>
            <button
              type="button"
              onClick={share}
              aria-label={label}
              className={cn(round, "hover:bg-yt-chip-hover max-sm:hover:bg-black/40")}
            >
              <ShareIcon className="size-6" />
            </button>
          </Labeled>
        )}
      />
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-12 flex-col items-center">
      {children}
      <span className="mt-1 w-16 truncate text-center text-xs leading-[18px] max-sm:text-white max-sm:drop-shadow">
        {label}
      </span>
    </div>
  );
}

// The panel beside a Short, as YouTube's: its title (and a count), a cross that closes it, and what it's for, which
// scrolls by itself. On a phone it comes up over the lower part of the Short.
function Panel({
  title,
  count,
  close,
  children,
}: {
  title: string;
  count?: number;
  close: () => void;
  children: (scroller: RefObject<HTMLDivElement | null>) => ReactNode;
}) {
  const t = useTranslations("youtube");
  const locale = useLocale();
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <aside className="flex h-full w-[min(480px,40vw)] shrink-0 flex-col overflow-hidden rounded-xl border border-black/10 bg-white max-md:absolute max-md:inset-x-2 max-md:bottom-2 max-md:z-20 max-md:h-[70%] max-md:w-auto max-md:shadow-xl">
      <div className="flex items-center justify-between gap-2 border-b border-black/10 py-2 pr-2 pl-4">
        <h2 className="text-xl leading-7 font-bold">
          {title}
          {count !== undefined && (
            <span className="ml-2 text-base font-normal text-yt-muted">{formatCount(count, locale)}</span>
          )}
        </h2>
        <button type="button" onClick={close} aria-label={t("close")} className={YT_ICON_BUTTON}>
          <XIcon className="size-6" />
        </button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-2">
        {children(scroller)}
      </div>
    </aside>
  );
}

// A Short's description, as YouTube's panel has it: the title, its likes, views and day in big type over their labels,
// then the description with YouTube's links
function About({
  video,
  description,
  channel,
}: {
  video: YouTubeVideo;
  description: string | null;
  channel?: YouTubeChannelDetails;
}) {
  const t = useTranslations("youtube");
  const locale = useLocale();
  const facts: [string, string, string?][] = [];
  if (video.likes !== null)
    facts.push([formatCompact(video.likes, locale, true), t("likes"), formatCount(video.likes, locale)]);
  if (video.views !== null)
    facts.push([formatCompact(video.views, locale, true), t("views"), formatCount(video.views, locale)]);
  if (video.published_at) facts.push(formatYouTubeDay(video.published_at, locale));
  return (
    <div className="space-y-4 pb-2">
      <p className="text-base leading-[22px] font-medium break-words">{video.title?.trim() || video.id}</p>
      {channel && (
        <YouTubeLink href={`/youtube/channels/${channel.id}`} className="flex w-fit items-center gap-3">
          <ChannelPicture url={channel.avatar_url} size={32} />
          <span className="text-sm font-medium">{channel.title?.trim() || channel.handle || channel.id}</span>
        </YouTubeLink>
      )}
      <div className="flex justify-around border-y border-black/10 py-4 text-center">
        {facts.map(([big, small, exact]) => (
          <div key={small} title={exact}>
            <p className="text-xl leading-7 font-bold">{big}</p>
            <p className="text-xs leading-[18px] text-yt-muted">{small}</p>
          </div>
        ))}
      </div>
      {description?.trim() && (
        <p className="text-sm leading-5 break-words whitespace-pre-wrap">
          <YouTubeText text={description.trim()} />
        </p>
      )}
    </div>
  );
}
