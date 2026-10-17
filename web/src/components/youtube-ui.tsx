"use client";

import { UserIcon } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import type { YouTubeVideo } from "@/api/types.gen";
import { When } from "@/components/when";
import { formatCompact, formatCount, formatDuration, pluralOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { avatarAt, thumbnail } from "@/lib/youtube";

// The pieces YouTube's pages here are made of, looking like YouTube's own: its font (Roboto), its near-black and grey,
// pill buttons, chips, and video cards with the length on the cover

// YouTube's buttons: black like its Subscribe button, or grey
export const YT_BUTTON =
  "inline-flex h-9 items-center gap-2 rounded-full bg-yt-text px-4 text-sm font-medium text-white hover:bg-[#272727]";
export const YT_BUTTON_GREY =
  "inline-flex h-9 items-center gap-2 rounded-full bg-yt-chip px-4 text-sm font-medium text-yt-text hover:bg-yt-chip-hover";

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

// YouTube's chips: a row of choices, the chosen one black
export function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-3 font-roboto">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-8 rounded-lg px-3 text-sm font-medium transition-colors",
            option.value === value ? "bg-yt-text text-white" : "bg-yt-chip text-yt-text hover:bg-yt-chip-hover",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
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

// A video's cover with its length in the corner, or "Unavailable" across a video YouTube no longer shows. Small covers
// take YouTube's 320 × 180 picture, the rest its 480 × 360 one, whose black bars the frame cuts off.
function Cover({
  video,
  vertical = false,
  small = false,
  className,
}: {
  video: YouTubeVideo;
  vertical?: boolean;
  small?: boolean;
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
      {!video.available ? (
        <span className="absolute inset-0 flex items-center justify-center text-sm font-medium text-yt-text">
          {t("unavailable")}
        </span>
      ) : (
        video.duration !== null &&
        !vertical && (
          <span className="absolute right-1.5 bottom-1.5 rounded bg-black/80 px-1 py-px text-xs font-medium text-white tabular-nums">
            {formatDuration(video.duration)}
          </span>
        )
      )}
    </div>
  );
}

// A video in a grid, as on a channel's Videos tab: its cover, its title in up to two lines, its views and age. The
// whole card opens the video's page.
export function VideoCard({ video }: { video: YouTubeVideo }) {
  return (
    <li className="group relative font-roboto">
      <Cover video={video} />
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

// A Short in a grid, as on a channel's Shorts tab: an upright cover, its title, and its views
export function ShortCard({ video }: { video: YouTubeVideo }) {
  const t = useTranslations("youtubeChannel");
  const locale = useLocale();
  return (
    <li className="relative font-roboto">
      <Cover video={video} vertical />
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

// A video beside another's page, as YouTube lists the next ones: a small cover, the title, the channel, views and age
export function SmallVideoCard({ video, channel }: { video: YouTubeVideo; channel: string }) {
  return (
    <li className="relative flex gap-2 font-roboto">
      <Cover video={video} small className="w-40 shrink-0 rounded-lg" />
      <div className="min-w-0">
        <Link
          href={`/youtube/videos/${video.id}`}
          prefetch={false}
          className="line-clamp-2 text-sm leading-snug font-medium text-yt-text after:absolute after:inset-0"
        >
          {video.title?.trim() || video.id}
        </Link>
        <p className="mt-1 truncate text-xs text-yt-muted">{channel}</p>
        <ViewsAndAge video={video} className="text-xs" />
      </div>
    </li>
  );
}
