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
import { usePathname, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, type RefObject, type WheelEvent, useEffect, useRef, useState } from "react";

import {
  youtubeChannelOptions,
  youtubeChannelVideosInfiniteOptions,
  youtubeVideoOptions,
} from "@/api/@tanstack/react-query.gen";
import type { YouTubeChannelDetails, YouTubeVideo } from "@/api/types.gen";
import { CommentList } from "@/components/youtube-comments";
import { ShortsGhost } from "@/components/youtube-ghosts";
import { ShareButton } from "@/components/youtube-share";
import { YouTubeText } from "@/components/youtube-text";
import { ChannelPicture, ShareIcon, YouTubeLink, YT_ICON_BUTTON } from "@/components/youtube-ui";
import { formatCompact, formatCount, formatYouTubeDay } from "@/lib/format";
import { FIRST_PAGE, nextPage } from "@/lib/pages";
import { cn } from "@/lib/utils";
import { type Sort } from "@/lib/youtube";

const PLAYER = "https://www.youtube-nocookie.com";
const AHEAD = 3; // Shorts left in the loaded list when its next page is asked for
const LOOK_FOR = 6; // pages of the channel's Shorts looked through for the one opened, when it isn't on the first
const WHEEL_STEP = 50; // the wheel's turn that goes to the next Short,
const WHEEL_REST = 700; // and the milliseconds before it can go on again

// The player's address for a Short: playing at once, from a second if given, round again at its end, without YouTube's
// controls (the page has its own), and taking the page's commands
const embed = (id: string, from = 0) =>
  `${PLAYER}/embed/${id}?autoplay=1&controls=0&loop=1&playlist=${id}&rel=0&playsinline=1&enablejsapi=1&iv_load_policy=3&disablekb=1&fs=0${from > 0 ? `&start=${from}` : ""}`;

// A Short's page, as YouTube's Shorts: the Short upright in the middle, as tall as the screen allows, with the channel
// and the title over its bottom; beside it, YouTube's round buttons, the likes, the comments (which open the comments'
// panel beside), and Share; and at the right, the arrows to the Short before and after it among the channel's Shorts,
// in the order they were listed in (the address's ?sort=…, newest first without it), which ↑ and ↓ and the wheel go
// to as well. Going from one to the next changes the address without asking the server for a page, so Back goes back
// through them; the next Shorts are in the list already, and each one's details are asked for as it comes. The Short
// shown follows the address only while that's a Short's: Next keeps a page one has left alive, hidden, and it mustn't
// go back to the one it opened on as the address moves to another page.
export function ShortsPage({ id: opened }: { id: string }) {
  const t = useTranslations("youtube");
  const common = useTranslations("common");
  const site = useTranslations("metadata");
  const shown = /^\/youtube\/shorts\/([^/]+)/.exec(usePathname())?.[1];
  const [id, setId] = useState(shown ?? opened);
  if (shown && shown !== id) setId(shown);
  const asked = useSearchParams().get("sort");
  const sort: Sort | undefined = asked === "popular" || asked === "oldest" ? asked : undefined;
  const details = useQuery(youtubeVideoOptions({ path: { video_id: id } })).data;
  const [channelId, setChannelId] = useState(details?.channel_id);
  if (details && details.channel_id !== channelId) setChannelId(details.channel_id);
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
  const at = shorts.findIndex((short) => short.id === id);
  const video: YouTubeVideo | undefined = details ?? shorts[at];
  const before = at > 0 ? shorts[at - 1] : undefined;
  const after = at >= 0 ? shorts[at + 1] : undefined;

  // The list loads on: further pages while the opened Short isn't on those loaded (a few at most), and the next one as
  // its end comes near
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const loaded = list.data?.pages.length ?? 0;
  const wanted =
    !!hasNextPage && !isFetchingNextPage && ((at < 0 && loaded < LOOK_FOR) || (at >= 0 && at >= shorts.length - AHEAD));
  useEffect(() => {
    if (wanted) void fetchNextPage();
  }, [wanted, fetchNextPage]);

  // The tab's title follows the Short shown, as the server wrote it for the first
  const title = video?.title?.trim() || id;
  useEffect(() => {
    document.title = `${title} · ${site("title")}`;
  }, [title, site]);

  const [panel, setPanel] = useState<"comments" | "description" | null>(null);
  const show = (short?: YouTubeVideo) =>
    short && window.history.pushState(null, "", `/youtube/shorts/${short.id}${window.location.search}`);

  // ↑ and ↓ go to the Short before and after, unless one's typing somewhere
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || target.isContentEditable) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const to = event.key === "ArrowUp" ? before : event.key === "ArrowDown" ? after : undefined;
      if (!to) return;
      event.preventDefault();
      window.history.pushState(null, "", `/youtube/shorts/${to.id}${window.location.search}`);
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [before, after]);

  // So does the wheel, a step at a time
  const rested = useRef(0);
  function wheel(event: WheelEvent) {
    if (Math.abs(event.deltaY) < WHEEL_STEP || event.timeStamp - rested.current < WHEEL_REST) return;
    rested.current = event.timeStamp;
    show(event.deltaY > 0 ? after : before);
  }

  if (!video) return <ShortsGhost label={common("loading")} />;
  return (
    <div className="relative flex h-[calc(100svh-3.5rem)] justify-center gap-6 overflow-hidden px-4 pt-2 pb-8 font-roboto text-yt-text">
      <div className="relative flex h-full min-w-0 items-center gap-3 sm:items-end" onWheel={wheel}>
        <ShortPlayer key={id} video={video} channel={channel} onTitle={() => setPanel("description")} />
        <Actions video={video} panel={panel} setPanel={setPanel} />
      </div>
      {panel && (
        <Panel
          title={panel === "comments" ? t("comments") : t("description")}
          count={panel === "comments" ? details?.comments_collected : undefined}
          close={() => setPanel(null)}
        >
          {(scroller) =>
            panel === "comments" ? (
              <CommentList key={id} id={id} owner={channelId} scroller={scroller} />
            ) : (
              <About video={video} description={details?.description ?? null} channel={channel} />
            )
          }
        </Panel>
      )}
      <div className="absolute top-1/2 right-6 hidden -translate-y-1/2 flex-col gap-4 md:flex">
        <button
          type="button"
          onClick={() => show(before)}
          disabled={!before}
          aria-label={t("previous")}
          className="flex size-14 items-center justify-center rounded-full bg-yt-chip hover:bg-yt-chip-hover disabled:invisible"
        >
          <ArrowUpIcon className="size-6" />
        </button>
        <button
          type="button"
          onClick={() => show(after)}
          disabled={!after}
          aria-label={t("next")}
          className="flex size-14 items-center justify-center rounded-full bg-yt-chip hover:bg-yt-chip-hover disabled:invisible"
        >
          <ArrowDownIcon className="size-6" />
        </button>
      </div>
    </div>
  );
}

// What the player last told about itself
type State = { playing: boolean; muted: boolean; time: number; duration: number };
const PLAYING = 1;
const BUFFERING = 3;

// The Short, played by YouTube's player with the page's own controls over it, as YouTube's Shorts have them: a click
// on it plays and pauses (K and the space bar too), a big play sign shows while it's paused, the play and sound
// buttons at its top left come under the mouse (M mutes), the red line along its bottom says where it's at and goes
// where it's clicked, and the channel and the title are over its bottom (the title opens the description). The player
// is 160 px taller than the frame at each end, so what YouTube puts along them (the title, its logo, and for a Short
// its own like count) falls outside it, while the Short, as wide as the frame, fills it. The player is loaded only once
// its page shows (an effect, which a hidden page doesn't run, gives it its address), so a page Next keeps alive,
// hidden, never plays; as the page goes, it's unloaded, and as it comes back, loaded again from where it was.
function ShortPlayer({
  video,
  channel,
  onTitle,
}: {
  video: YouTubeVideo;
  channel?: YouTubeChannelDetails;
  onTitle: () => void;
}) {
  const t = useTranslations("youtube");
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<State>({ playing: true, muted: false, time: 0, duration: video.duration ?? 0 });
  const last = useRef(state); // the same, for the effect's handlers
  useEffect(() => {
    last.current = state;
  });
  const send = (func: string, args: unknown[] = []) =>
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), PLAYER);
  const toggle = () => send(last.current.playing ? "pauseVideo" : "playVideo");
  const mute = () => {
    send(last.current.muted ? "unMute" : "mute");
    setState((now) => ({ ...now, muted: !now.muted }));
  };
  const seek = (seconds: number) => {
    send("seekTo", [seconds, true]);
    setState((now) => ({ ...now, time: seconds }));
  };

  useEffect(() => {
    const player = frame.current;
    if (!player) return;
    const listen = () =>
      player.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: video.id, channel: "widget" }),
        PLAYER,
      );
    const heard = (event: MessageEvent) => {
      if (event.source !== player.contentWindow || typeof event.data !== "string") return;
      let info;
      try {
        info = JSON.parse(event.data)?.info;
      } catch {
        return; // not the player's message
      }
      if (!info || typeof info !== "object") return;
      setState((now) => ({
        playing:
          typeof info.playerState === "number"
            ? info.playerState === PLAYING || info.playerState === BUFFERING
            : now.playing,
        muted: typeof info.muted === "boolean" ? info.muted : now.muted,
        time: typeof info.currentTime === "number" ? info.currentTime : now.time,
        duration: typeof info.duration === "number" && info.duration > 0 ? info.duration : now.duration,
      }));
    };
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || target.isContentEditable) return;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(target.tagName) && event.key === " ") return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const command = { " ": "toggle", k: "toggle", m: "mute" }[event.key];
      if (!command) return;
      event.preventDefault();
      const message = command === "mute" ? (last.current.muted ? "unMute" : "mute") : undefined;
      if (message) {
        player.contentWindow?.postMessage(JSON.stringify({ event: "command", func: message, args: [] }), PLAYER);
        setState((now) => ({ ...now, muted: !now.muted }));
      } else {
        const func = last.current.playing ? "pauseVideo" : "playVideo";
        player.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args: [] }), PLAYER);
      }
    };
    window.addEventListener("message", heard);
    window.addEventListener("keydown", key);
    player.addEventListener("load", listen);
    player.src = embed(video.id, Math.floor(last.current.time)); // from the start, or from where it was
    return () => {
      window.removeEventListener("message", heard);
      window.removeEventListener("keydown", key);
      player.removeEventListener("load", listen);
      player.src = "about:blank";
    };
  }, [video.id]);

  const name = channel?.handle ?? (channel?.title?.trim() || video.title?.trim() || "");
  return (
    <div
      className="group/short relative h-full shrink overflow-hidden rounded-xl bg-black"
      style={{ aspectRatio: "9 / 16", maxHeight: "calc((100vw - 32px) * 16 / 9)" }}
    >
      <iframe
        ref={frame}
        src="about:blank"
        title={video.title ?? video.id}
        allow="autoplay; encrypted-media; picture-in-picture; web-share"
        tabIndex={-1}
        className="pointer-events-none absolute inset-x-0 -top-[160px] h-[calc(100%+320px)] w-full"
      />
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
          onClick={onTitle}
          className="pointer-events-auto mt-2 line-clamp-2 text-left text-sm leading-5 break-words"
        >
          {video.title?.trim() || video.id}
        </button>
      </div>
      <Progress state={state} seek={seek} />
    </div>
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
  setPanel,
}: {
  video: YouTubeVideo;
  panel: "comments" | "description" | null;
  setPanel: (panel: "comments" | "description" | null) => void;
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
          onClick={() => setPanel(panel === "comments" ? null : "comments")}
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
        look={({ open, label }) => (
          <Labeled label={label}>
            <button
              type="button"
              onClick={open}
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
