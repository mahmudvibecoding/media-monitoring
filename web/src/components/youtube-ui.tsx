"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { PlayIcon, UserIcon } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { type ComponentProps, type ReactElement, type SVGProps, useEffect, useRef, useState } from "react";

import type { YouTubeVideo } from "@/api/types.gen";
import { When } from "@/components/when";
import { useNow } from "@/lib/use-now";
import { formatCompact, formatCount, formatDuration, pluralOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { avatarAt, bigThumbnail, thumbnail } from "@/lib/youtube";

// The pieces YouTube's pages here are made of, looking like YouTube's own, in its sizes: its font (Roboto), its
// near-black and grey, its pills, its tooltips, and its videos' cards, with the length on the cover and, under the
// title, the views by its play sign and how long ago

// A link between YouTube's pages here, which shows YouTube's red line along the top of the window while the page it
// opens is on its way (unless it's there already)
export function YouTubeLink({ children, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link {...props}>
      {children}
      <Loading />
    </Link>
  );
}

function Loading() {
  const { pending } = useLinkStatus();
  return pending ? (
    <span aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-0.5 origin-left animate-yt-loading bg-yt-red" />
  ) : null;
}

// YouTube's tooltip: a grey label under what's pointed at, once the mouse has stayed on it a moment
export function YouTubeTip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger delay={400} render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="bottom" sideOffset={8} className="z-50">
          <TooltipPrimitive.Popup className="rounded bg-[#616161]/90 p-2 font-roboto text-xs leading-[18px] text-white">
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// YouTube's grey pill, 40 px high, for a count (which can't be clicked) or, under the mouse a shade darker, a button
export const YT_PILL =
  "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-yt-chip px-4 text-sm font-medium text-yt-text";

// YouTube's round grey button for an icon: 40 px, darker under the mouse
export const YT_ICON_BUTTON =
  "flex size-10 shrink-0 items-center justify-center rounded-full text-yt-text hover:bg-yt-chip-hover";

// YouTube's share sign, an arrow leaving to the right, drawn like lucide's lines
export function ShareIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M13.5 4.5 21 11.25 13.5 18v-3.75c-5 0-8.25 1.5-10.5 5 .75-5.5 3.75-10 10.5-11Z" />
    </svg>
  );
}

// The bullet YouTube puts between two things said on one line: @handle • 1,2 млн подписчиков. The line wraps at its
// spaces, as text does, when it doesn't fit.
export function Dot() {
  return <span aria-hidden="true"> • </span>;
}

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

// Under a video's title, as YouTube's lists write it: ▷ 2,6 тыс. • 1 ч назад, the views by YouTube's play sign, cut
// short, then how long ago, the short way; the exact views on hover
export function VideoMeta({ video, className }: { video: YouTubeVideo; className?: string }) {
  const t = useTranslations("youtubeChannel");
  const locale = useLocale();
  return (
    <p className={cn("text-yt-muted", className)}>
      {video.views !== null && (
        <span
          className="whitespace-nowrap"
          title={t("viewCount", { count: video.views, formatted: formatCount(video.views, locale) })}
        >
          <PlayIcon className="mr-1 inline size-3 align-[-1px]" strokeWidth={2.5} aria-hidden="true" />
          {formatCompact(video.views, locale, true)}
        </span>
      )}
      {video.views !== null && video.published_at && <Dot />}
      {video.published_at && <When iso={video.published_at} youtube="short" className="whitespace-nowrap" />}
    </p>
  );
}

// The blue YouTube puts round a video's card under the mouse, a little wider than the card, with round corners (the
// card is a group, and isolated, so the tint stays behind its content)
export function Tint() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -inset-1.5 -z-10 rounded-2xl bg-yt-tint opacity-0 transition-opacity group-hover:opacity-100"
    />
  );
}

const PREVIEW_AFTER = 500; // milliseconds the mouse stays on a video before it plays, so passing over doesn't start it
const NEW_FOR = 7 * 24 * 60 * 60 * 1000; // how long YouTube marks a video "New" beside another: under a week

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

// A cover's picture from YouTube's image server: the first of sources it has, the next when it answers with an error or
// with its 120 × 90 grey stand-in for a picture it hasn't got (looked at once in the browser too, for a picture that
// came before the page was the browser's)
export function CoverImage({ sources, className }: { sources: string[]; className?: string }) {
  const [tried, setTried] = useState(0);
  const image = useRef<HTMLImageElement>(null);
  const missing = (picture: HTMLImageElement) => picture.complete && picture.naturalWidth <= 120;
  const next = () => setTried((last) => Math.min(last + 1, sources.length - 1));
  useEffect(() => {
    if (image.current && missing(image.current)) next();
  });
  return (
    // Straight from YouTube, as the channel's picture
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={image}
      src={sources[tried]}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={next}
      onLoad={(event) => {
        if (missing(event.currentTarget)) next();
      }}
      className={className}
    />
  );
}

// A video's cover with its length in YouTube's dark label at the bottom right, or "Unavailable" across a video YouTube
// no longer shows. A grid's covers take the 640 × 480 picture, the side list's the 480 × 360 one, whose black bars a
// 16:9 frame cuts off. A Short's is upright, in YouTube's 2:3 frame: its picture, which is the upright one in the middle
// of a wider one, is enlarged until the upright one fills the frame's width. While playing, the video plays over it in
// YouTube's player, without sound or controls, from the start and round again; the player takes no clicks, so a click
// still opens the video's page. With fresh, a video out less than a week has YouTube's white "New" at its top left
// (once the browser knows the time: see useNow).
function Cover({
  video,
  vertical = false,
  small = false,
  playing = false,
  fresh = false,
  className,
}: {
  video: YouTubeVideo;
  vertical?: boolean;
  small?: boolean;
  playing?: boolean;
  fresh?: boolean;
  className?: string;
}) {
  const t = useTranslations("youtubeChannel");
  const now = useNow();
  const isNew = fresh && now !== null && !!video.published_at && now - Date.parse(video.published_at) < NEW_FOR;
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-yt-chip",
        vertical ? "aspect-[2/3] rounded-lg" : "aspect-video rounded-xl",
        className,
      )}
    >
      <CoverImage
        sources={small ? [thumbnail(video.id, "hq")] : [bigThumbnail(video.id), thumbnail(video.id, "hq")]}
        className={cn(
          "size-full object-cover",
          vertical && "scale-[1.185]",
          !video.available && "opacity-40 grayscale",
        )}
      />
      {playing && video.available && <Preview video={video} />}
      {isNew && !playing && (
        <span className="absolute top-1 left-1 rounded bg-white px-1 py-px text-xs leading-[18px] font-medium text-yt-text">
          {t("new")}
        </span>
      )}
      {!video.available ? (
        <span className="absolute inset-0 flex items-center justify-center text-sm font-medium text-yt-text">
          {t("unavailable")}
        </span>
      ) : (
        video.duration !== null &&
        !vertical &&
        !playing && (
          <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 py-px text-xs leading-[18px] font-medium text-white">
            {formatDuration(video.duration)}
          </span>
        )
      )}
    </div>
  );
}

// The video playing over its cover, as YouTube's previews play: the video alone, without sound, controls or the player's
// own lines. The player still puts the video's title along its top and its logo along its bottom, so it's 60 px taller
// than the cover at each end: the video, as wide as the cover, fills the cover's height in its middle, and what's
// along its ends falls outside the cover, which cuts it off. The cover shows through until the player has loaded. As
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
      src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&loop=1&playlist=${video.id}&iv_load_policy=3&disablekb=1&fs=0&cc_load_policy=0`}
      title={video.title ?? video.id}
      allow="autoplay; encrypted-media; picture-in-picture"
      tabIndex={-1}
      aria-hidden="true"
      onLoad={() => setLoaded(true)}
      className={cn(
        "pointer-events-none absolute inset-x-0 -top-[60px] h-[calc(100%+120px)] w-full transition-opacity duration-300",
        loaded ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

// A video in a grid, as on a channel's Videos tab: its cover, which plays the video while the mouse stays on the card,
// its title in up to two lines, then its views and how long ago. The whole card opens the video's page.
export function VideoCard({ video }: { video: YouTubeVideo }) {
  const { playing, ...hover } = usePreview();
  return (
    <li className="group relative isolate font-roboto" {...hover}>
      <Tint />
      <Cover video={video} playing={playing} />
      <div className="mt-3 pr-6">
        <YouTubeLink
          href={`/youtube/videos/${video.id}`}
          prefetch={false}
          className="line-clamp-2 text-base leading-[22px] font-medium break-words text-yt-text after:absolute after:inset-0"
        >
          {video.title?.trim() || video.id}
        </YouTubeLink>
        <VideoMeta video={video} className="mt-0.5 text-sm leading-5" />
      </div>
    </li>
  );
}

// A Short in a grid, as on a channel's Shorts tab: its upright cover, which plays it while the mouse stays on the card,
// its title, and its views. It opens on its Shorts page, which goes on to the next ones in the grid's order (sort).
export function ShortCard({ video, sort }: { video: YouTubeVideo; sort?: string }) {
  const t = useTranslations("youtubeChannel");
  const locale = useLocale();
  const { playing, ...hover } = usePreview();
  return (
    <li className="group relative isolate font-roboto" {...hover}>
      <Tint />
      <Cover video={video} vertical playing={playing} />
      <div className="pt-2 pr-4">
        <YouTubeLink
          href={`/youtube/shorts/${video.id}${sort ? `?sort=${sort}` : ""}`}
          prefetch={false}
          className="mb-1 line-clamp-2 text-base leading-[22px] font-medium break-words text-yt-text after:absolute after:inset-0"
        >
          {video.title?.trim() || video.id}
        </YouTubeLink>
        {video.views !== null && (
          <p className="text-sm leading-5 text-yt-muted" title={formatCount(video.views, locale)}>
            {t("viewCount", { count: pluralOf(video.views), formatted: formatCompact(video.views, locale, true) })}
          </p>
        )}
      </div>
    </li>
  );
}

// A video found by a channel's search, as YouTube lists results: its cover beside its title, in bigger type, and its
// views and how long ago; a Short opens on its Shorts page
export function ResultCard({ video }: { video: YouTubeVideo }) {
  const { playing, ...hover } = usePreview();
  return (
    <li className="group relative isolate flex gap-4 font-roboto" {...hover}>
      <Tint />
      <Cover video={video} playing={playing} className="w-[min(360px,45%)] shrink-0" />
      <div className="min-w-0 flex-1 pt-0.5">
        <YouTubeLink
          href={`/youtube/${video.kind === "short" ? "shorts" : "videos"}/${video.id}`}
          prefetch={false}
          className="line-clamp-2 text-lg leading-[26px] break-words text-yt-text after:absolute after:inset-0"
        >
          {video.title?.trim() || video.id}
        </YouTubeLink>
        <VideoMeta video={video} className="mt-1 text-xs leading-[18px]" />
      </div>
    </li>
  );
}

// A video beside another's page, as YouTube lists the next ones: its cover (which plays the video while the mouse stays
// on the card) beside its title in up to three lines, its channel, its views and how long ago. On a phone's width
// (of the page, which is a container), the cover takes the whole width and the rest goes under it, as in YouTube's
// app.
export function SmallVideoCard({ video, channel }: { video: YouTubeVideo; channel: string }) {
  const { playing, ...hover } = usePreview();
  return (
    <li className="group relative isolate flex gap-3 font-roboto @max-[600px]:flex-col @max-[600px]:gap-2" {...hover}>
      <Tint />
      <Cover
        video={video}
        small
        fresh
        playing={playing}
        className="w-[min(248px,58%)] shrink-0 rounded-lg @max-[600px]:w-full @max-[600px]:rounded-xl"
      />
      <div className="min-w-0 flex-1 @max-[600px]:pb-4">
        <YouTubeLink
          href={`/youtube/videos/${video.id}`}
          prefetch={false}
          className="line-clamp-3 text-sm leading-5 font-medium break-words text-yt-text after:absolute after:inset-0 @max-[600px]:line-clamp-2 @max-[600px]:text-base @max-[600px]:leading-[22px]"
        >
          {video.title?.trim() || video.id}
        </YouTubeLink>
        <p className="mt-1 truncate text-xs leading-[18px] text-yt-muted">{channel}</p>
        <VideoMeta video={video} className="text-xs leading-[18px]" />
      </div>
    </li>
  );
}
