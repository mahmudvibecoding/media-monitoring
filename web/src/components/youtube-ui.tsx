"use client";

import { ArrowLeftIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import type { YouTubeVideo } from "@/api/types.gen";
import { YouTubeLogo } from "@/components/brand-icons";
import { SearchBox } from "@/components/search-box";
import { When } from "@/components/when";
import { formatCompact, formatCount, formatDuration, pluralOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { avatarAt, channelsAddress, thumbnail } from "@/lib/youtube";

// The pieces YouTube's pages here are made of, looking like YouTube's own: its font (Roboto), its near-black and grey,
// pill buttons, and video cards with the length on the cover

// The top of a YouTube channel's or video's page, as YouTube's own: a way back, its logo, which goes to the channels,
// and its search box, which searches them (on Enter, in the channels' list), as the list's own top has them. Back is
// the page one came from on the site, or, for a page opened by its address, up (the channels).
export function YouTubeMasthead() {
  const t = useTranslations("youtubeChannels");
  const common = useTranslations("common");
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 font-roboto text-yt-text">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={common("back")}
          title={common("back")}
          onClick={() => (window.history.length > 1 ? router.back() : router.push("/youtube/channels"))}
          className="-ml-2 flex size-10 items-center justify-center rounded-full hover:bg-yt-chip"
        >
          <ArrowLeftIcon className="size-6" strokeWidth={1.5} />
        </button>
        <Link href="/youtube/channels" aria-label="YouTube">
          <YouTubeLogo className="h-5 w-[93px]" />
        </Link>
      </div>
      <SearchBox
        look="youtube"
        search=""
        placeholder={t("search")}
        onEnter
        onSearch={(search) => router.push(`/youtube/channels${channelsAddress({ search: search || undefined })}`)}
      />
    </div>
  );
}

// YouTube's button, black like its Subscribe button; and its grey pill, for a count, which can't be clicked
export const YT_BUTTON =
  "inline-flex h-9 items-center gap-2 rounded-full bg-yt-text px-4 text-sm font-medium text-white hover:bg-[#272727]";
export const YT_PILL =
  "inline-flex h-9 items-center gap-2 rounded-full bg-yt-chip px-4 text-sm font-medium text-yt-text";

// A channel's picture, round; a grey circle with a figure while it has none, or until it loads
export function ChannelPicture({ url, size, className }: { url: string | null; size: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-yt-chip", className)}
      style={{ width: size, height: size }}
    >
      {url && !failed ? (
        // Straight from YouTube: Next's image optimizer would fetch it through the site's server, which can't reach
        // the internet. Twice the size shown, for sharp screens.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarAt(url, size * 2)}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <UserIcon className="size-1/2 text-yt-muted" strokeWidth={1.5} />
      )}
    </span>
  );
}

// "48K views · 3 days ago", as under a video on YouTube
export function ViewsAndAge({ video, className }: { video: YouTubeVideo; className?: string }) {
  const t = useTranslations("youtubeChannel");
  const locale = useLocale();
  return (
    <p className={cn("text-sm text-yt-muted", className)}>
      {video.views !== null && (
        <span title={formatCount(video.views, locale)}>
          {t("viewCount", { count: pluralOf(video.views), formatted: formatCompact(video.views, locale, true) })}
        </span>
      )}
      {video.views !== null && video.published_at && " · "}
      {video.published_at && <When iso={video.published_at} youtube />}
    </p>
  );
}

const PREVIEW_AFTER = 500; // milliseconds the mouse stays on a video before it plays, so passing over doesn't start it

// Whether a card's video plays, as on YouTube: once the mouse has stayed on the card a moment, until it leaves, or its
// page goes (Next keeps a page one has left alive, hidden, where the mouse never leaves the card)
function usePreview() {
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      setPlaying(false);
    },
    [],
  );
  return {
    playing,
    onMouseEnter: () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setPlaying(true), PREVIEW_AFTER);
    },
    onMouseLeave: () => {
      clearTimeout(timer.current);
      setPlaying(false);
    },
  };
}

// A video's cover with its length in the corner, or "Unavailable" across a video YouTube no longer shows. Small covers
// take YouTube's 320 × 180 picture, the rest its 480 × 360 one, whose black bars the frame cuts off. While playing, the
// video plays over it in YouTube's player, without sound or controls, from the start and round again; the player
// takes no clicks, so a click still opens the video's page.
function Cover({
  video,
  vertical = false,
  small = false,
  playing = false,
  className,
}: {
  video: YouTubeVideo;
  vertical?: boolean;
  small?: boolean;
  playing?: boolean;
  className?: string;
}) {
  const t = useTranslations("youtubeChannel");
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl bg-yt-chip",
        vertical ? "aspect-[9/16]" : "aspect-video",
        className,
      )}
    >
      {/* Straight from YouTube, as the channel's picture. A Short's cover is 4:3 with the video upright in its middle,
          which a 9:16 frame keeps. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={thumbnail(video.id, small ? "mq" : "hq")}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className={cn("size-full object-cover", !video.available && "opacity-40 grayscale")}
      />
      {playing && video.available && <Preview video={video} />}
      {!video.available ? (
        <span className="absolute inset-0 flex items-center justify-center text-sm font-medium text-yt-text">
          {t("unavailable")}
        </span>
      ) : (
        video.duration !== null &&
        !vertical &&
        !playing && (
          <span className="absolute right-1.5 bottom-1.5 rounded bg-black/80 px-1 py-px text-xs font-medium text-white tabular-nums">
            {formatDuration(video.duration)}
          </span>
        )
      )}
    </div>
  );
}

// The video playing over its cover, without sound or controls; the cover shows through until the player has loaded. As
// its page goes (Next keeps it alive, hidden), the player is unloaded at once.
function Preview({ video }: { video: YouTubeVideo }) {
  const [loaded, setLoaded] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const player = frame.current;
    return () => {
      if (player) player.src = "about:blank";
    };
  }, []);
  return (
    <iframe
      ref={frame}
      src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&loop=1&playlist=${video.id}&iv_load_policy=3&disablekb=1`}
      title={video.title ?? video.id}
      allow="autoplay; encrypted-media; picture-in-picture"
      tabIndex={-1}
      aria-hidden="true"
      onLoad={() => setLoaded(true)}
      className={cn(
        "pointer-events-none absolute inset-0 size-full transition-opacity duration-300",
        loaded ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

// A video in a grid, as on a channel's Videos tab: its cover, which plays the video while the mouse stays on the card,
// its title in up to two lines, its views and age. The whole card opens the video's page.
export function VideoCard({ video }: { video: YouTubeVideo }) {
  const { playing, ...hover } = usePreview();
  return (
    <li className="group relative font-roboto" {...hover}>
      <Cover video={video} playing={playing} />
      <div className="mt-3 pr-2">
        <Link
          href={`/youtube/videos/${video.id}`}
          prefetch={false}
          className="line-clamp-2 text-base leading-snug font-medium text-yt-text after:absolute after:inset-0"
        >
          {video.title?.trim() || video.id}
        </Link>
        <ViewsAndAge video={video} className="mt-1" />
      </div>
    </li>
  );
}

// A Short in a grid, as on a channel's Shorts tab: an upright cover, which plays it while the mouse stays on the card,
// its title, and its views
export function ShortCard({ video }: { video: YouTubeVideo }) {
  const t = useTranslations("youtubeChannel");
  const locale = useLocale();
  const { playing, ...hover } = usePreview();
  return (
    <li className="relative font-roboto" {...hover}>
      <Cover video={video} vertical playing={playing} />
      <Link
        href={`/youtube/videos/${video.id}`}
        prefetch={false}
        className="mt-2 line-clamp-2 text-base leading-snug font-medium text-yt-text after:absolute after:inset-0"
      >
        {video.title?.trim() || video.id}
      </Link>
      {video.views !== null && (
        <p className="mt-1 text-sm text-yt-muted" title={formatCount(video.views, locale)}>
          {t("viewCount", { count: pluralOf(video.views), formatted: formatCompact(video.views, locale, true) })}
        </p>
      )}
    </li>
  );
}

// A video beside another's page, as YouTube lists the next ones: a small cover, which plays the video while the mouse
// stays on the card, the title, the channel, views and age
export function SmallVideoCard({ video, channel }: { video: YouTubeVideo; channel: string }) {
  const { playing, ...hover } = usePreview();
  return (
    <li className="relative flex gap-2 font-roboto" {...hover}>
      <Cover video={video} small playing={playing} className="w-[168px] shrink-0 rounded-lg" />
      <div className="min-w-0">
        <Link
          href={`/youtube/videos/${video.id}`}
          prefetch={false}
          className="line-clamp-2 text-sm leading-5 font-medium text-yt-text after:absolute after:inset-0"
        >
          {video.title?.trim() || video.id}
        </Link>
        <p className="mt-1 truncate text-xs text-yt-muted">{channel}</p>
        <ViewsAndAge video={video} className="text-xs" />
      </div>
    </li>
  );
}
