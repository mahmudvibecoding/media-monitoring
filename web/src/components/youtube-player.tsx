"use client";

import {
  CheckIcon,
  FastForwardIcon,
  MaximizeIcon,
  MinimizeIcon,
  PauseIcon,
  PlayIcon,
  RewindIcon,
  SettingsIcon,
  SkipForwardIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type ComponentProps,
  createContext,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { PageLoadingLine, useGo } from "@/components/page-link";
import { BUFFERING, command, cropped, embed, PLAYING, useEmbedded } from "@/components/youtube-embed";
import { CoverImage } from "@/components/youtube-ui";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { bigThumbnail, thumbnail } from "@/lib/youtube";

// What a page can ask of its player: to go to a second (a time in the description or a comment), and where it's at
export type PlayerControls = { seek: (seconds: number) => void; position: () => number };

const PlayerContext = createContext<RefObject<PlayerControls | null> | null>(null);

// Around a video's page: lets its texts' times reach its player
export function PlayerProvider({ children }: { children: ReactNode }) {
  const controls = useRef<PlayerControls | null>(null);
  return <PlayerContext value={controls}>{children}</PlayerContext>;
}

// The page's player, once it's there (null outside a video's page)
export const usePlayer = () => useContext(PlayerContext);

const CROP = 60; // px of the player above and below its frame
const IDLE = 3000; // ms without the mouse moving after which the controls hide while the video plays, as YouTube's
const BLOCKED_AFTER = 2500; // ms after which a video that hasn't started is taken as not allowed to start by itself
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// What the player last told about itself, and whether the video has started (its picture shows until then)
type State = {
  state: number;
  time: number;
  duration: number;
  loaded: number; // the share of the video loaded
  muted: boolean;
  volume: number; // 0 to 100
  rate: number;
  started: boolean;
  failed: boolean; // YouTube's player can't play the video here: its own screen shows, saying why
  live: boolean; // a stream or a premiere: until it plays, the player's own screen shows, saying when it starts
};

// YouTube's sign that comes and fades in the middle (or for a jump, at the side) as one plays, pauses, jumps or changes
// the sound
type Bezel = { kind: "play" | "pause" | "mute" | "volume" | "back" | "forward"; text?: string; at: number };

// The video, played here by YouTube's player with the page's own controls, as YouTube's watch page has them: at the
// bottom, over a shade, the red line of where it's at (what's loaded lighter; the time under the mouse; a click or a
// drag takes the video there), and under it play and pause, the next video, the sound (its slider comes under the
// mouse), the time, the speed and the full screen; they hide 3 s after the mouse stops while the video plays, and with
// them the cursor. A click on the video plays and pauses it, a double click fills the screen. YouTube's keys work: K or
// the space bar, J and L (10 s back and on), ← and → (5 s), ↑ and ↓ (the sound, while the player has the focus), M, F,
// Shift+N (the next video), and 0 to 9 (that tenth of the video). The video starts as the page opens, with sound once
// one has clicked something on the site, as browsers allow; without, YouTube's big red button waits for a click. Its
// picture shows until it has started. YouTube's own controls are off and it takes no clicks; it's 60 px taller than its
// frame at each end, so that its title and logo fall outside it (its ⏸ still shows a moment as a video starts: see
// youtube-embed). It's loaded only as its page shows and unloaded as it goes (Next keeps a page one has left alive,
// hidden), and loaded again on coming back, from the second it had got to. A video the player can't play here (removed,
// private, kept from the country it's watched in, not to be played on other sites) shows the player's own screen,
// which says why, as YouTube's watch page does, without the picture and the controls; so does a premiere or a stream
// that hasn't started, its screen saying when it will, until it plays.
export function Player({ id, title, next }: { id: string; title: string; next?: { id: string; title: string } }) {
  const t = useTranslations("youtube");
  const [go, going] = useGo();
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({
    state: -1,
    time: 0,
    duration: 0,
    loaded: 0,
    muted: false,
    volume: 100,
    rate: 1,
    started: false,
    failed: false,
    live: false,
  });
  const last = useRef(state); // the same, for the handlers
  useEffect(() => {
    last.current = state;
  });
  const [awake, setAwake] = useState(true); // whether the controls show
  const [menu, setMenu] = useState(false); // whether the speed's menu is open
  const [bezel, setBezel] = useState<Bezel | null>(null);
  const [full, setFull] = useState(false);
  const [blocked, setBlocked] = useState(false); // the video didn't start by itself
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const controlsRef = usePlayer();
  const playing = state.state === PLAYING || state.state === BUFFERING;

  const frame = useEmbedded(
    id,
    () => embed(id, { from: last.current.time }), // from the start, or from where it was
    (info) => {
      if (info.playerState === PLAYING) setBlocked(false);
      setState((now) => ({
        state: typeof info.playerState === "number" ? info.playerState : now.state,
        time: typeof info.currentTime === "number" ? info.currentTime : now.time,
        duration: typeof info.duration === "number" && info.duration > 0 ? info.duration : now.duration,
        loaded: typeof info.videoLoadedFraction === "number" ? info.videoLoadedFraction : now.loaded,
        muted: typeof info.muted === "boolean" ? info.muted : now.muted,
        volume: typeof info.volume === "number" ? info.volume : now.volume,
        rate: typeof info.playbackRate === "number" ? info.playbackRate : now.rate,
        started: now.started || info.playerState === PLAYING,
        failed: now.failed || info.error !== undefined,
        live: info.videoData ? info.videoData.isLive === true : now.live,
      }));
    },
  );
  // The player's own screen, in place of the page's picture and controls: it says why it can't play the video, or when
  // a premiere or a stream starts (and takes the click that plays it then)
  const own = state.failed || (state.live && !state.started);
  const crop = own ? 0 : CROP; // the player's own screen whole, a premiere's countdown at its bottom too

  const send = (func: string, args: unknown[] = []) => command(frame.current, func, args);

  function wake() {
    setAwake(true);
    clearTimeout(idle.current);
    idle.current = setTimeout(() => setAwake(false), IDLE);
  }
  const flash = (kind: Bezel["kind"], text?: string) => setBezel((now) => ({ kind, text, at: (now?.at ?? 0) + 1 }));
  const isPlaying = () => last.current.state === PLAYING || last.current.state === BUFFERING;

  function play() {
    send("playVideo");
    setBlocked(false);
  }
  function toggle() {
    if (isPlaying()) {
      send("pauseVideo");
      flash("pause");
    } else {
      play();
      flash("play");
    }
  }
  function seek(seconds: number) {
    const to = Math.max(0, last.current.duration > 0 ? Math.min(seconds, last.current.duration - 0.5) : seconds);
    send("seekTo", [to, true]);
    setState((now) => ({ ...now, time: to }));
  }
  function skip(by: number) {
    seek(last.current.time + by);
    flash(by < 0 ? "back" : "forward", t("seconds", { count: Math.abs(by) }));
  }
  function setVolume(volume: number) {
    const level = Math.round(Math.max(0, Math.min(100, volume)));
    send("setVolume", [level]);
    send(level === 0 ? "mute" : "unMute");
    setState((now) => ({ ...now, volume: level, muted: level === 0 }));
    return level;
  }
  function toggleMute() {
    if (last.current.muted || last.current.volume === 0) {
      setVolume(last.current.volume || 50);
      flash("volume");
    } else {
      send("mute");
      setState((now) => ({ ...now, muted: true }));
      flash("mute");
    }
  }
  function fullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen();
  }
  function setRate(rate: number) {
    send("setPlaybackRate", [rate]);
    setState((now) => ({ ...now, rate }));
    setMenu(false);
  }
  const goNext = () => next && go(`/youtube/videos/${next.id}`);

  // A video that hasn't started a moment after the player came is waiting for a click: YouTube's big button shows
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!last.current.started) setBlocked(true);
    }, BLOCKED_AFTER);
    return () => clearTimeout(timer);
  }, [id]);

  useEffect(() => {
    const changed = () => setFull(!!box.current && document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      clearTimeout(idle.current);
    };
  }, []);

  // The times in the description and the comments take the player there and play it, and the page up to it
  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = {
      seek: (seconds) => {
        seek(seconds);
        send("playVideo");
        window.scrollTo({ top: 0, behavior: "smooth" }); // the player is at the top of the page
      },
      position: () => last.current.time,
    };
    return () => {
      controlsRef.current = null;
    };
  });

  // YouTube's keys, unless one's typing somewhere (the space bar presses what has the focus); ↑ and ↓ only while the
  // player has the focus, so that they still scroll the page
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const { failed, live, started } = last.current;
      if (failed || (live && !started)) return; // the player's own screen takes no keys
      if (event.metaKey || event.ctrlKey || event.altKey || target.isContentEditable) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const focused = !!box.current?.contains(document.activeElement);
      const length = last.current.duration;
      switch (event.key) {
        case " ":
          if (["BUTTON", "A"].includes(target.tagName)) return;
          toggle();
          break;
        case "k":
        case "K":
          toggle();
          break;
        case "j":
          skip(-10);
          break;
        case "l":
          skip(10);
          break;
        case "ArrowLeft":
          skip(-5);
          break;
        case "ArrowRight":
          skip(5);
          break;
        case "ArrowUp":
        case "ArrowDown": {
          if (!focused) return;
          const from = last.current.muted ? 0 : last.current.volume;
          const level = setVolume(from + (event.key === "ArrowUp" ? 5 : -5));
          flash(level === 0 ? "mute" : "volume", `${level}%`);
          break;
        }
        case "m":
        case "M":
          toggleMute();
          break;
        case "f":
        case "F":
          fullscreen();
          break;
        case "N":
          if (!event.shiftKey || !next) return;
          goNext();
          break;
        default:
          if (/^[0-9]$/.test(event.key) && length > 0) seek((length * Number(event.key)) / 10);
          else return;
      }
      event.preventDefault();
      wake();
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const shown = awake || !playing || menu || !state.started;
  return (
    <div
      ref={box}
      tabIndex={-1}
      onMouseMove={wake}
      onMouseLeave={() => {
        if (isPlaying() && !menu) setAwake(false);
      }}
      className={cn(
        "group/player relative aspect-video overflow-hidden rounded-xl bg-black outline-none select-none [&:fullscreen]:rounded-none",
        !shown && "cursor-none",
      )}
    >
      {going && <PageLoadingLine color="youtube" />}
      {!state.started && !own && (
        <CoverImage
          sources={[`https://i.ytimg.com/vi_webp/${id}/maxresdefault.webp`, bigThumbnail(id), thumbnail(id, "hq")]}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      <iframe
        ref={frame}
        src="about:blank"
        title={title}
        allow="autoplay; encrypted-media; picture-in-picture"
        tabIndex={-1}
        style={cropped(crop)}
        className={cn(
          "absolute transition-opacity duration-300",
          !own && "pointer-events-none",
          state.started || own ? "opacity-100" : "opacity-0",
        )}
      />
      {/* The video's face: a click plays and pauses it (or closes the menu), a double click fills the screen */}
      {!own && (
        <div
          className="absolute inset-0"
          onClick={() => {
            box.current?.focus({ preventScroll: true });
            if (menu) setMenu(false);
            else toggle();
          }}
          onDoubleClick={fullscreen}
        />
      )}
      {state.state === BUFFERING && state.started && <Spinner />}
      {blocked && !state.started && !own && <BigPlay label={t("play")} onClick={play} />}
      {bezel && <BezelSign key={bezel.at} bezel={bezel} />}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 transition-opacity duration-200",
          shown ? "opacity-100" : "pointer-events-none opacity-0",
          own && "hidden",
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-linear-to-t from-black/70 via-black/25 to-transparent" />
        <Progress state={state} playing={playing} seek={seek} label={t("seek")} />
        <div className="relative flex h-12 items-center px-1.5 text-white sm:px-3">
          <ControlButton label={playing ? t("pause") : t("play")} onClick={toggle}>
            {playing ? <PauseIcon className="size-6 fill-white" /> : <PlayIcon className="size-6 fill-white" />}
          </ControlButton>
          {next && (
            <ControlButton label={`${t("nextVideo")}: ${next.title}`} onClick={goNext}>
              <SkipForwardIcon className="size-6 fill-white" />
            </ControlButton>
          )}
          <Volume
            level={state.muted ? 0 : state.volume}
            label={state.muted || state.volume === 0 ? t("unmute") : t("mute")}
            sliderLabel={t("volume")}
            toggle={toggleMute}
            set={setVolume}
          />
          <span className="ml-1 text-[13px] whitespace-nowrap tabular-nums [text-shadow:0_0_2px_rgb(0_0_0/0.5)]">
            {formatDuration(Math.floor(state.time))} / {formatDuration(Math.floor(state.duration))}
          </span>
          <span className="flex-1" />
          <div className="relative">
            <ControlButton label={t("settings")} onClick={() => setMenu(!menu)}>
              <SettingsIcon className={cn("size-6 transition-transform duration-200", menu && "rotate-30")} />
            </ControlButton>
            {menu && (
              <div className="absolute right-0 bottom-12 w-[min(240px,70vw)] rounded-xl bg-[rgb(28_28_28/0.9)] py-2 text-sm text-white shadow-lg backdrop-blur-md">
                <p className="px-4 pt-1 pb-2 text-[13px] font-medium text-white/70">{t("speed")}</p>
                {SPEEDS.map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    onClick={() => setRate(speed)}
                    className="flex h-9 w-full items-center gap-3 px-4 text-left hover:bg-white/10"
                  >
                    <CheckIcon className={cn("size-4", speed !== state.rate && "invisible")} />
                    {speed === 1 ? t("normal") : String(speed)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <ControlButton label={full ? t("exitFullscreen") : t("fullscreen")} onClick={fullscreen}>
            {full ? <MinimizeIcon className="size-6" /> : <MaximizeIcon className="size-6" />}
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

// A button of the controls: white, with YouTube's faint shadow, its name on hover
function ControlButton({ label, className, children, ...props }: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "flex size-12 shrink-0 items-center justify-center opacity-90 [filter:drop-shadow(0_0_2px_rgb(0_0_0/0.5))] hover:opacity-100",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// The red line of where the video is at: between the player's reports it moves on by itself while the video plays;
// what's loaded shows lighter, and under the mouse the line is thicker, with its dot, the share up to the mouse and the
// time there; a click or a drag takes the video there
function Progress({
  state,
  playing,
  seek,
  label,
}: {
  state: State;
  playing: boolean;
  seek: (seconds: number) => void;
  label: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const played = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null); // the share of the video under the mouse
  const [drag, setDrag] = useState<number | null>(null); // where a drag is at
  useEffect(() => {
    let frame = 0;
    const from = performance.now();
    const tick = () => {
      const time = playing ? state.time + ((performance.now() - from) / 1000) * state.rate : state.time;
      const share = drag ?? (state.duration > 0 ? Math.min(1, time / state.duration) : 0);
      if (played.current) played.current.style.transform = `scaleX(${share})`;
      if (dot.current) dot.current.style.left = `${share * 100}%`;
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [state.time, state.duration, state.rate, playing, drag]);
  const shareAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  };
  return (
    <div
      ref={bar}
      role="slider"
      tabIndex={-1}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.floor(state.duration)}
      aria-valuenow={Math.floor(state.time)}
      aria-valuetext={`${formatDuration(Math.floor(state.time))} / ${formatDuration(Math.floor(state.duration))}`}
      onPointerMove={(event) => {
        const share = shareAt(event);
        setHover(share);
        if (drag !== null) setDrag(share);
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag(shareAt(event));
      }}
      onPointerUp={(event) => {
        if (drag !== null && state.duration > 0) seek(shareAt(event) * state.duration);
        setDrag(null);
      }}
      className="group/progress relative mx-3 h-4 cursor-pointer touch-none"
    >
      <div className="absolute inset-x-0 bottom-1.5 h-[3px] bg-white/20 transition-[height] duration-100 group-hover/progress:h-[5px]">
        <div className="absolute inset-y-0 left-0 bg-white/40" style={{ width: `${state.loaded * 100}%` }} />
        {hover !== null && (
          <div className="absolute inset-y-0 left-0 bg-white/50" style={{ width: `${hover * 100}%` }} />
        )}
        <div
          ref={played}
          className="absolute inset-0 origin-left bg-[linear-gradient(to_right,#ff0033_80%,#ff2791)]"
          style={{ transform: "scaleX(0)" }}
        />
        <div
          ref={dot}
          className={cn(
            "absolute top-1/2 size-[13px] -translate-1/2 rounded-full bg-[#ff0033] transition-transform duration-100",
            hover === null && drag === null ? "scale-0" : "scale-100",
          )}
        />
      </div>
      {hover !== null && state.duration > 0 && (
        <span
          className="pointer-events-none absolute bottom-6 -translate-x-1/2 rounded-md bg-black/70 px-2 py-0.5 text-[13px] font-medium text-white tabular-nums"
          style={{ left: `clamp(24px, ${hover * 100}%, calc(100% - 24px))` }}
        >
          {formatDuration(Math.floor(hover * state.duration))}
        </span>
      )}
    </div>
  );
}

// The sound's button, and its slider, which comes out beside it under the mouse
function Volume({
  level,
  label,
  sliderLabel,
  toggle,
  set,
}: {
  level: number;
  label: string;
  sliderLabel: string;
  toggle: () => void;
  set: (level: number) => unknown;
}) {
  const levelAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * 100;
  };
  let icon = <Volume2Icon className="size-6" />;
  if (level === 0) icon = <VolumeXIcon className="size-6" />;
  else if (level < 50) icon = <Volume1Icon className="size-6" />;
  return (
    <div className="group/volume flex items-center">
      <ControlButton label={label} onClick={toggle}>
        {icon}
      </ControlButton>
      <div className="w-0 overflow-hidden transition-[width] duration-200 group-focus-within/volume:w-16 group-hover/volume:w-16">
        <div
          role="slider"
          tabIndex={-1}
          aria-label={sliderLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={level}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            set(levelAt(event));
          }}
          onPointerMove={(event) => {
            if (event.buttons & 1) set(levelAt(event));
          }}
          className="relative mx-2 h-10 w-[52px] cursor-pointer touch-none"
        >
          <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 bg-white/20">
            <div className="h-full bg-white" style={{ width: `${level}%` }} />
          </div>
          <div className="absolute top-1/2 size-3 -translate-1/2 rounded-full bg-white" style={{ left: `${level}%` }} />
        </div>
      </div>
    </div>
  );
}

// YouTube's spinner while the video waits for more of itself
function Spinner() {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 left-1/2 size-16 -translate-1/2 animate-spin"
    >
      <circle
        cx="32"
        cy="32"
        r="26"
        fill="none"
        stroke="white"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray="110 60"
      />
    </svg>
  );
}

// YouTube's big red play button, while the video waits for a click to start
function BigPlay({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="absolute top-1/2 left-1/2 -translate-1/2 opacity-90 transition-opacity hover:opacity-100"
    >
      <svg viewBox="0 0 68 48" width="68" height="48" aria-hidden="true">
        <rect width="68" height="48" rx="14" fill="#ff0033" />
        <path d="M27 14v20l18-10z" fill="#fff" />
      </svg>
    </button>
  );
}

// The sign that comes and fades: in the middle, play, pause or the sound (with its level), growing as it fades, as
// YouTube's; for a jump, at the side it goes to, with how far
function BezelSign({ bezel }: { bezel: Bezel }) {
  if (bezel.kind === "back" || bezel.kind === "forward") {
    return (
      <div
        className={cn(
          "pointer-events-none absolute top-1/2 flex -translate-y-1/2 animate-yt-seek flex-col items-center gap-1 text-white",
          bezel.kind === "back" ? "left-[12%]" : "right-[12%]",
        )}
      >
        <span className="flex size-14 items-center justify-center rounded-full bg-black/45">
          {bezel.kind === "back" ? (
            <RewindIcon className="size-6 fill-white" />
          ) : (
            <FastForwardIcon className="size-6 fill-white" />
          )}
        </span>
        <span className="text-[13px] font-medium [text-shadow:0_0_2px_rgb(0_0_0/0.6)]">{bezel.text}</span>
      </div>
    );
  }
  const icons = {
    play: <PlayIcon className="size-7 fill-white" />,
    pause: <PauseIcon className="size-7 fill-white" />,
    mute: <VolumeXIcon className="size-7" />,
    volume: <Volume2Icon className="size-7" />,
  };
  return (
    <>
      {bezel.text && (
        <span className="pointer-events-none absolute top-[10%] left-1/2 -translate-x-1/2 animate-yt-seek rounded-md bg-black/50 px-3 py-1.5 text-base font-medium text-white">
          {bezel.text}
        </span>
      )}
      <span className="pointer-events-none absolute top-1/2 left-1/2 flex size-[52px] -translate-1/2 animate-yt-bezel items-center justify-center rounded-full bg-black/50 text-white">
        {icons[bezel.kind]}
      </span>
    </>
  );
}
