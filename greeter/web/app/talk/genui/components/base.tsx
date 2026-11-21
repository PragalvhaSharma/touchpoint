"use client";

// What every moment shares: the motion language of app/greeter.tsx (spring, no bounce), pictures that hold
// their space and fall back through a list of sources, faces that find their own photo by name, live
// numbers that count, and the width a drawing has to work with.
import type { ComponentRenderer } from "@openuidev/react-lang";
import { animate, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { z } from "zod/v4";

export const SPRING = { type: "spring", bounce: 0, duration: 0.4 } as const;
/** For things that settle slowly into place: a photo coming into focus, a line being drawn. */
export const SETTLE = { type: "spring", bounce: 0, duration: 0.9 } as const;
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;

/** Props while streaming: anything may still be missing, so every renderer reads them defensively. */
type Loose<T> = T extends (infer U)[] ? Loose<U>[] : T extends object ? { [K in keyof T]?: Loose<T[K]> } : T;

/** A renderer for one schema definition. */
export type View<D extends { props: z.ZodObject }> = ComponentRenderer<Loose<z.infer<D["props"]>>>;

/** Items of a data array, skipping the half-streamed ones. */
export function each<T>(items: (T | null | undefined)[] | null | undefined, ok: (t: T) => boolean = () => true): T[] {
  return (Array.isArray(items) ? items : []).filter((t): t is T => t != null && ok(t));
}

export const isHttp = (u?: string | null): u is string => !!u && /^https?:\/\//i.test(u);
export const isSrc = (u?: string | null): u is string => !!u && (/^https?:\/\//i.test(u) || u.startsWith("/"));

export const domain = (u?: string | null) => {
  if (!u) return null;
  try {
    return new URL(u, "http://local").hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
};

export const initials = (name?: string | null) =>
  (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "?";

export const firstName = (name?: string | null) => (name ?? "").trim().split(/\s+/)[0] ?? "";

// ─── People, looked up once per name ──────────────────────────────────────────

type Known = { id: string; name: string; photo: string | null; images?: string[] };
const people = new Map<string, Promise<Known | null>>();

function lookup(name: string): Promise<Known | null> {
  const key = name.trim().toLowerCase();
  let hit = people.get(key);
  if (!hit) {
    hit = fetch(`/api/talk/data?op=person&q=${encodeURIComponent(name.trim())}`)
      .then((r) => (r.ok ? (r.json() as Promise<Known | null>) : null))
      .then((p) => (p && p.name.toLowerCase().includes(key.split(/\s+/)[0]) ? p : null))
      .catch(() => null);
    people.set(key, hit);
  }
  return hit;
}

/** The greeter's own crop of a face: the one picture that is always a real photo of this person. */
export const isFaceCrop = (u?: string | null): u is string => !!u && u.startsWith("/api/greeter/face?");
/** LinkedIn profile photos are near-always the person's face (X and GitHub avatars often are not). */
const isProfilePhoto = (u?: string | null): u is string => !!u && /media\.licdn\.com\/dms\/image\/.*profile-displayphoto/.test(u);

function useKnown(name?: string | null): Known | null {
  const [found, setFound] = useState<{ name: string; p: Known | null } | null>(null);
  const n = (name ?? "").trim();
  useEffect(() => {
    if (n.length < 3) return;
    let live = true;
    lookup(n).then((p) => live && setFound({ name: n, p }));
    return () => {
      live = false;
    };
  }, [n]);
  return found?.name === n ? found.p : null;
}

/**
 * Pictures that show this person's face, best first: the greeter's crop (given, or found by name), then for
 * a large portrait their LinkedIn photo. Never an avatar, logo or page image: without a face, a monogram.
 */
export function usePhotos(name?: string | null, given?: (string | null | undefined)[], profile = false): string[] {
  const known = useKnown(name);
  const local = [...(given ?? []), known?.photo].filter(isFaceCrop);
  const external = profile ? [...(given ?? []), ...(known?.images ?? [])].filter(isProfilePhoto) : [];
  return [...new Set([...local, ...external])];
}

// ─── Live data ────────────────────────────────────────────────────────────────

/** Counts from 0 to the target the first time it is known, then glides to any new target. */
export function useCount(target: number | null, duration = 1.4): number {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (target == null || !Number.isFinite(target)) return;
    if (reduce) {
      from.current = target;
      const id = requestAnimationFrame(() => setShown(target));
      return () => cancelAnimationFrame(id);
    }
    const a = animate(from.current, target, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        from.current = v;
        setShown(v);
      },
    });
    return () => a.stop();
  }, [target, duration, reduce]);
  return shown;
}

/** The width of a box, for drawings laid out in pixels. 0 until measured. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** The size of a box, for moments that lay themselves out to fill the space they are given. 0 until measured. */
export function useBox<T extends HTMLElement>(): [RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (w: number, h: number) => setBox((b) => (b.w === Math.round(w) && b.h === Math.round(h) ? b : { w: Math.round(w), h: Math.round(h) }));
    const r = el.getBoundingClientRect();
    set(r.width, r.height);
    const ro = new ResizeObserver(([e]) => set(e.contentRect.width, e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box];
}

export const clamp = (lo: number, v: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Seconds since this component first appeared: lets late-streaming parts join an entrance already under way. */
export function useAge(): () => number {
  const born = useRef(0);
  useEffect(() => {
    born.current = performance.now();
  }, []);
  return () => (born.current ? (performance.now() - born.current) / 1000 : 0);
}

// ─── Pictures ─────────────────────────────────────────────────────────────────

/**
 * An image in a box of fixed shape: the space is held before it loads, it fades in when ready, and a broken
 * source falls through to the next one, then to a quiet fallback instead of a broken icon.
 */
export function Picture({
  srcs,
  alt = "",
  className,
  imgClassName,
  fit = "cover",
  fallback,
  style,
  onReady,
}: {
  srcs: (string | null | undefined)[];
  alt?: string;
  className?: string;
  imgClassName?: string;
  fit?: "cover" | "contain";
  fallback?: ReactNode;
  style?: CSSProperties;
  onReady?: (src: string) => void;
}) {
  const list = srcs.filter(isSrc);
  // Sources that failed stay failed, and a source that loaded stays shown when the list grows around it.
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const src = list.find((s) => !failed.includes(s));
  const ready = !!src && loaded === src;
  return (
    <div style={style} className={(/\b(absolute|fixed)\b/.test(className ?? "") ? "" : "relative ") + "overflow-hidden " + (className ?? "")}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          src={src}
          alt={alt}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => {
            setLoaded(src);
            onReady?.(src);
          }}
          onError={() => setFailed((f) => [...f, src])}
          className={
            "absolute inset-0 h-full w-full transition-opacity duration-500 ease-out " +
            (fit === "cover" ? "object-cover " : "object-contain ") +
            (imgClassName ?? "")
          }
          style={{ opacity: ready ? 1 : 0 }}
        />
      ) : null}
      {!ready && fallback ? <div className="absolute inset-0 grid place-items-center">{fallback}</div> : null}
    </div>
  );
}

/** The light a picture gives off: itself, far out of focus, behind it. Gone with reduced transparency. */
export function Glow({ src, className, opacity = 0.5 }: { src?: string | null; className?: string; opacity?: number }) {
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden
      referrerPolicy="no-referrer"
      className={
        "pointer-events-none absolute -z-10 object-cover blur-[64px] saturate-[1.6] [@media(prefers-reduced-transparency:reduce)]:hidden " +
        (className ?? "")
      }
      style={{ opacity }}
    />
  );
}

/** A round face, or their initials set in glass when the greeter has no photo of them. */
export function Face({
  name,
  srcs,
  size,
  className,
  style,
}: {
  name?: string | null;
  srcs: string[];
  size: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Picture
      srcs={srcs}
      alt={name ?? ""}
      style={{ width: size, height: size, ...style }}
      className={
        "shrink-0 rounded-full bg-[linear-gradient(160deg,rgba(255,255,255,0.16),rgba(255,255,255,0.04))] backdrop-blur-xl " +
        "shadow-[0_12px_28px_-10px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.22),inset_0_0_0_1px_rgba(255,255,255,0.08)] " +
        (className ?? "")
      }
      imgClassName="rounded-full"
      fallback={
        <span style={{ fontSize: Math.max(11, size * 0.34) }} className="font-semibold tracking-[0.02em] text-white/85">
          {initials(name)}
        </span>
      }
    />
  );
}

/** Someone's face, from the greeter's crop of it (found by name when not given), else their initials. */
export function PersonFace({ name, photo, size, className }: { name?: string | null; photo?: string | null; size: number; className?: string }) {
  const srcs = usePhotos(name, [photo]);
  return <Face name={name} srcs={srcs} size={size} className={className} />;
}

/** Where something came from: the site's own icon and its name, quiet, opening the page. */
export function SourceMark({ href, label, className }: { href?: string | null; label?: string | null; className?: string }) {
  const host = domain(href);
  const text = label || host;
  if (!text) return null;
  const body = (
    <>
      {host && (
        <Picture
          srcs={[`https://www.google.com/s2/favicons?domain=${host}&sz=64`]}
          className="size-4 shrink-0 rounded-[4px] bg-white/10"
          fallback={<span className="size-1.5 rounded-full bg-label-3" />}
        />
      )}
      <span className="truncate">{text}</span>
    </>
  );
  const cls = "inline-flex max-w-full items-center gap-2 text-[13px] font-medium text-label-3 " + (className ?? "");
  return isHttp(href) ? (
    <a href={href} target="_blank" rel="noreferrer" className={cls + " rounded-[6px] transition-colors duration-150 hover:text-label-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue"}>
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

/** Light inline emphasis in a glance: **bold** and [link](url), nothing else. */
export function inline(text?: string | null): ReactNode {
  if (!text) return null;
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={i++} className="font-semibold text-label">{m[1]}</strong>);
    else if (isHttp(m[3]))
      out.push(
        <a key={i++} href={m[3]} target="_blank" rel="noreferrer" className="text-label underline decoration-white/30 underline-offset-[3px] hover:decoration-white/70">
          {m[2]}
        </a>,
      );
    else out.push(m[2]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ─── Geometry for the drawn moments ────────────────────────────────────────────

export type Pt = { x: number; y: number };

/** A smooth curve through points (Catmull-Rom as cubic Béziers). */
export function through(pts: Pt[], tension = 0.5): string {
  if (!pts.length) return "";
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const k = tension / 3;
    d += ` C${p1.x + (p2.x - p0.x) * k},${p1.y + (p2.y - p0.y) * k} ${p2.x - (p3.x - p1.x) * k},${p2.y - (p3.y - p1.y) * k} ${p2.x},${p2.y}`;
  }
  return d;
}
