"use client";

// A thing someone built, live: its picture, the stars counting up to today's number, the language as a
// coloured mark, and a year of commits as one drawn pulse. Numbers come from GitHub as it renders, never
// from the model.
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { Repo } from "../../../api/talk/data/store";
import type * as S from "../schema";
import { EASE_IN_OUT, Glow, Picture, SETTLE, clamp, domain, isHttp, isSrc, through, useBox, useCount, useWidth, type View } from "./base";

type Load = { url: string; repo: Repo | null; done: boolean; days: number | null };
const cache = new Map<string, Promise<Repo | null>>();

function getRepo(url: string) {
  let hit = cache.get(url);
  if (!hit) {
    hit = fetch(`/api/talk/data?op=repo&url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? (r.json() as Promise<Repo>) : null))
      .catch(() => null);
    cache.set(url, hit);
  }
  return hit;
}

function useRepo(url?: string | null): Load {
  const want = url && /github\.com\/[^/\s]+/i.test(url) ? url.trim() : "";
  const [state, setState] = useState<Load>({ url: "", repo: null, done: false, days: null });
  useEffect(() => {
    if (!want) return;
    let live = true;
    getRepo(want).then((repo) => {
      // how long since the last push, read once when it arrives (not on every render)
      const days = repo?.pushedAt ? (Date.now() - Date.parse(repo.pushedAt)) / 86_400_000 : null;
      if (live) setState({ url: want, repo, done: true, days: days != null && Number.isFinite(days) ? days : null });
    });
    return () => {
      live = false;
    };
  }, [want]);
  return state.url === want ? state : { url: want, repo: null, done: !want, days: null };
}

// GitHub's own language colours (linguist), for the ones hackers write in.
const LANG: Record<string, string> = {
  Verilog: "#b2b7f8", SystemVerilog: "#DAE1C2", VHDL: "#adb2cb", Python: "#3572A5", "Jupyter Notebook": "#DA5B0B",
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Rust: "#dea584", "C++": "#f34b7d", C: "#555555", Cuda: "#3A4E3A",
  Go: "#00ADD8", Swift: "#F05138", Kotlin: "#A97BFF", Java: "#b07219", "C#": "#178600", Ruby: "#701516", Dart: "#00B4AB",
  HTML: "#e34c26", CSS: "#663399", Svelte: "#ff3e00", Vue: "#41b883", Shell: "#89e051", Zig: "#ec915c", Haskell: "#5e5086",
  Lua: "#000080", Elixir: "#6e4a7e", Scala: "#c22d40", R: "#198CE7", Julia: "#a270ba", MATLAB: "#e16737", Assembly: "#6E4C13",
  "Objective-C": "#438eff", PHP: "#4F5D95", Mojo: "#ff4c1f", Astro: "#ff5a03", MDX: "#fcb32c",
};

function ago(days: number | null): string | null {
  if (days == null) return null;
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 14) return `${Math.round(days)} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const y = Math.round(days / 365);
  return y === 1 ? "a year ago" : `${y} years ago`;
}

export const ProjectMomentView: View<typeof S.ProjectMoment> = ({ props }) => {
  const reduce = useReducedMotion();
  const { repo, done, days } = useRepo(props.url);
  const name = repo?.name ?? props.name ?? (props.url ? domain(props.url) : null) ?? "";
  const line = props.line || repo?.description || "";
  const href = repo?.url ?? (isHttp(props.url) ? props.url : null);
  const image = repo?.image ?? (isSrc(props.image) ? props.image : null);
  const diagram = repo?.imageKind === "readme";
  const stars = useCount(repo ? repo.stars : null, 1.6);
  const [shown, setShown] = useState<string | null>(null);
  const fresh = days != null && days < 30;

  // Side by side when the space is wide, stacked when it is tall; the picture takes what the words leave.
  const [ref, { w, h }] = useBox<HTMLElement>();
  const side = w >= 600 && w / Math.max(1, h) > 1.15;
  const textW = side ? clamp(260, w * 0.42, 440) : w;
  const title = clamp(28, (side ? textW : w) * (side ? 0.1 : 0.08), 56);
  const big = side ? clamp(48, textW * 0.2, 104) : clamp(44, w * 0.13, 80);
  // stacked, the words claim their height first and the picture takes what is left (or steps aside)
  const textH = title * 1.1 + 56 + big + 40 + 76;
  const gapY = clamp(20, h * 0.04, 36);
  const iw = side ? Math.min(w - textW - w * 0.06, h * 1.25) : Math.min(w, (h - textH - gapY) * 1.25);
  const ih = iw * 0.8;
  const showImage = side || ih >= 130;

  return (
    <article
      ref={ref}
      className={"relative isolate flex h-full w-full justify-center " + (side ? "flex-row items-center" : "flex-col items-center")}
      style={{ gap: side ? w * 0.06 : gapY }}
    >
      {w > 0 && (
        <>
          {/* The picture: a diagram or screenshot shown whole on a sheet of paper, a social image to the edges. */}
          {showImage && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, filter: "blur(10px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            transition={reduce ? { duration: 0.25 } : SETTLE}
            className="relative shrink-0"
            style={{ width: iw, height: ih }}
          >
            {!diagram && <Glow src={shown} className="-inset-[8%] size-[116%] rounded-[40px]" opacity={0.45} />}
            <div
              className={
                "relative size-full overflow-hidden shadow-[0_50px_90px_-40px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.07)] " +
                (diagram ? "bg-white" : "bg-raised")
              }
              style={{ borderRadius: clamp(22, iw * 0.06, 36) }}
            >
              {image ? (
                <Picture
                  srcs={[image]}
                  alt={name ? `${name}` : ""}
                  fit={diagram ? "contain" : "cover"}
                  className={diagram ? "absolute inset-[6%]" : "absolute inset-0"}
                  onReady={setShown}
                />
              ) : (
                <Placeholder name={name} color={LANG[repo?.language ?? ""]} loading={!done} />
              )}
              {!diagram && <div className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]" />}
            </div>
          </motion.div>
          )}

          <div className="min-w-0 shrink-0" style={{ width: side ? textW : Math.min(w, Math.max(iw, 320)) }}>
            <h2 className="text-balance font-bold leading-[1.02] tracking-[-0.035em]" style={{ fontSize: title }}>
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" className="rounded-[8px] decoration-white/30 underline-offset-[6px] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue">
                  {name}
                </a>
              ) : (
                name
              )}
            </h2>
            {line && (
              <p className="mt-3 line-clamp-2 max-w-[40ch] text-pretty leading-[1.42] text-label-2" style={{ fontSize: clamp(15, title * 0.36, 19) }}>
                {line}
              </p>
            )}

            <motion.div
              initial={false}
              animate={{ opacity: repo ? 1 : 0 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="flex flex-wrap items-end gap-x-6 gap-y-2"
              style={{ marginTop: clamp(20, big * 0.4, 40) }}
              aria-hidden={!repo}
            >
              <p className="flex items-center gap-[0.12em] font-bold leading-none tracking-[-0.045em] tabular-nums" style={{ fontSize: big }}>
                <StarMark />
                {Math.round(stars).toLocaleString("en-US")}
              </p>
              {repo?.language && (
                <p className="mb-[0.4em] flex items-center gap-2 font-medium text-label-2" style={{ fontSize: clamp(15, big * 0.2, 19) }}>
                  <span className="size-[0.62em] rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]" style={{ background: LANG[repo.language] ?? "var(--label-3)" }} />
                  {repo.language}
                </p>
              )}
            </motion.div>
            {repo && <span className="sr-only">{repo.stars.toLocaleString("en-US")} stars on GitHub</span>}

            {repo && repo.year.length > 0 && <Pulse year={repo.year} fresh={fresh} when={ago(days)} />}
          </div>
        </>
      )}
    </article>
  );
};

/** A year of commits, a week at a time, drawn left to right; the last twelve weeks in full light. */
function Pulse({ year, fresh, when }: { year: number[]; fresh: boolean; when: string | null }) {
  const reduce = useReducedMotion();
  const [ref, w] = useWidth<HTMLDivElement>();
  const h = 44;
  const max = Math.max(1, ...year);
  const n = year.length;
  const pts = year.map((c, i) => ({ x: (i / Math.max(1, n - 1)) * w, y: h - 3 - (Math.sqrt(c) / Math.sqrt(max)) * (h - 8) }));
  const d = w ? through(pts, 0.35) : "";
  const recent = Math.max(0, n - 12);
  const split = n > 1 ? recent / (n - 1) : 0;
  const tone = fresh ? "var(--green)" : "rgba(235,235,245,0.75)";
  const last = pts[pts.length - 1];
  return (
    <div className="mt-7">
      <div ref={ref} className="relative h-[44px] w-full">
        {w > 0 && (
          <svg width={w} height={h} className="absolute inset-0 overflow-visible" aria-hidden>
            <defs>
              <linearGradient id="pulse-fade" x1="0" x2={w} y1="0" y2="0" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor={tone} stopOpacity="0.22" />
                <stop offset={split} stopColor={tone} stopOpacity="0.32" />
                <stop offset={Math.min(1, split + 0.0001)} stopColor={tone} stopOpacity="1" />
                <stop offset="1" stopColor={tone} stopOpacity="1" />
              </linearGradient>
            </defs>
            <line x1="0" x2={w} y1={h - 3} y2={h - 3} stroke="rgba(235,235,245,0.1)" strokeWidth="1" />
            <motion.path
              d={d}
              fill="none"
              stroke="url(#pulse-fade)"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? { opacity: 0 } : { pathLength: 0 }}
              animate={reduce ? { opacity: 1 } : { pathLength: 1 }}
              transition={reduce ? { duration: 0.3 } : { duration: 1.4, ease: EASE_IN_OUT, delay: 0.2 }}
            />
            {last && (
              <motion.circle
                cx={last.x}
                cy={last.y}
                r="3.5"
                fill={tone}
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: reduce ? 0 : 1.5, duration: 0.3, ease: "easeOut" }}
                style={{ transformOrigin: `${last.x}px ${last.y}px` }}
              />
            )}
          </svg>
        )}
      </div>
      <div className="mt-2 flex justify-between text-[12px] font-medium text-label-3">
        <span>A year of commits</span>
        {when && <span className="tabular-nums">Last push {when}</span>}
      </div>
    </div>
  );
}

function Placeholder({ name, color, loading }: { name: string; color?: string; loading: boolean }) {
  return (
    <div className="absolute inset-0 grid place-items-center overflow-hidden">
      <div
        className="absolute inset-0 opacity-60"
        style={{ background: `radial-gradient(120% 90% at 20% 10%, ${color ?? "#3a3a3c"}55, transparent 60%), radial-gradient(90% 80% at 90% 100%, #0a84ff22, transparent 60%)` }}
      />
      {!loading && <span className="title relative px-8 text-center text-[34px] font-bold tracking-[-0.03em] text-white/80">{name}</span>}
    </div>
  );
}

function StarMark() {
  return (
    <svg width="0.6em" height="0.6em" viewBox="0 0 24 24" aria-hidden className="shrink-0 text-orange">
      <path
        fill="currentColor"
        d="M12 2.6c.4 0 .75.23.92.6l2.33 4.98 5.44.67c.4.05.73.32.85.7.13.39.02.81-.28 1.08l-4.02 3.72 1.07 5.38c.08.39-.08.8-.4 1.03-.33.24-.76.26-1.11.07L12 18.17l-4.8 2.66c-.35.2-.78.17-1.11-.07a1.03 1.03 0 0 1-.4-1.03l1.07-5.38-4.02-3.72a1.03 1.03 0 0 1-.28-1.08c.12-.38.45-.65.85-.7l5.44-.67 2.33-4.98c.17-.37.53-.6.92-.6z"
      />
    </svg>
  );
}
