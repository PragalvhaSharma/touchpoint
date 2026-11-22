"use client";

// The thing they did, when it has no repo or picture of its own: a project, a role, an event, a club, a prize.
// Their face and the organisation's mark on top, a few large words for the thing, one line about it, then up to
// three beats, each with a drawn mark, arriving in turn. Logos come from public/logos (no network at the venue).
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type * as S from "../schema";
import { PersonFace, SETTLE, clamp, each, inline, isSrc, Picture, useBox, type View } from "./base";
import { ICON } from "./primitives";

type LogoEntry = { name: string; file: string; aliases?: string[] };
let logoIndex: Promise<LogoEntry[]> | null = null;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The local logo for an organisation, when its name leads with one we have ("OpenAI", "Ivey Product Society"). */
function useLogo(org?: string | null): string | null {
  const [hit, setHit] = useState<{ org: string; file: string | null } | null>(null);
  const want = norm(org ?? "");
  useEffect(() => {
    if (want.length < 2) return;
    let live = true;
    logoIndex ??= fetch("/logos/index.json").then((r) => (r.ok ? (r.json() as Promise<LogoEntry[]>) : [])).catch(() => []);
    logoIndex.then((list) => {
      const names = (e: LogoEntry) => [e.name, ...(e.aliases ?? [])].map(norm).filter(Boolean);
      const found = list
        .flatMap((e) => names(e).map((n) => ({ n, e })))
        .filter(({ n }) => want === n || want.startsWith(n + " "))
        .sort((a, b) => b.n.length - a.n.length)[0];
      if (live) setHit({ org: want, file: found?.e.file ?? null });
    });
    return () => {
      live = false;
    };
  }, [want]);
  return hit?.org === want ? hit.file : null;
}

type Beat = { text?: string; mark?: string };

export const SpotlightView: View<typeof S.Spotlight> = ({ props }) => {
  const reduce = useReducedMotion();
  const [ref, { w }] = useBox<HTMLElement>();
  const logo = useLogo(props.org);
  const beats = each(props.beats as Beat[] | undefined, (b) => !!b.text?.trim()).slice(0, 3);
  const title = (props.title ?? "").trim();
  const size = clamp(30, w * 0.085, 54);
  const image = isSrc(props.image) ? props.image : null;
  const rise = (i: number) =>
    reduce
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2 } }
      : { initial: { opacity: 0, y: 14, filter: "blur(6px)" }, animate: { opacity: 1, y: 0, filter: "blur(0px)" }, transition: { ...SETTLE, duration: 0.7, delay: i * 0.08 } };

  return (
    <article ref={ref} className="relative isolate flex h-full w-full flex-col justify-center gap-5 py-2">
      {/* a soft light behind the words, in the panel's accent */}
      <span aria-hidden className="pointer-events-none absolute -left-10 top-0 -z-10 size-[260px] rounded-full bg-[rgba(165,148,255,0.16)] blur-[70px]" />

      {(props.person || props.kicker || logo) && (
        <motion.div {...rise(0)} className="flex items-center gap-3">
          {props.person && <PersonFace name={props.person} photo={props.photo} size={44} />}
          <div className="min-w-0 flex-1">
            {props.person && <p className="truncate text-[15px] font-semibold leading-tight text-label">{props.person}</p>}
            {props.kicker && <p className="truncate text-[12.5px] font-semibold uppercase tracking-[0.09em] text-[#a594ff]">{props.kicker}</p>}
          </div>
          {logo && (
            <span className="grid h-11 w-[104px] shrink-0 place-items-center rounded-[12px] bg-white px-2.5 py-1.5 shadow-[0_10px_24px_-12px_rgba(0,0,0,0.9)]">
              {/* eslint-disable-next-line @next/next/no-img-element -- a local SVG logo, no optimising to do */}
              <img src={logo} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
            </span>
          )}
        </motion.div>
      )}

      {title && (
        <h3 className="title text-balance font-bold leading-[1.02] tracking-[-0.03em] text-white" style={{ fontSize: size }}>
          {title.split(/\s+/).map((word, i) => (
            <motion.span key={word + i} className="inline-block whitespace-pre" {...rise(i + 1)}>
              {word + " "}
            </motion.span>
          ))}
        </h3>
      )}

      {props.line && (
        <motion.p {...rise(2)} className="max-w-[44ch] text-pretty text-[16.5px] leading-[1.45] text-label-2">
          {inline(props.line)}
        </motion.p>
      )}

      {image && (
        <motion.div {...rise(3)} className="relative aspect-[16/9] w-full overflow-hidden rounded-[18px] bg-raised shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">
          <Picture srcs={[image]} alt="" className="absolute inset-0" />
        </motion.div>
      )}

      {beats.length > 0 && (
        <ul className="flex flex-col gap-2">
          {beats.map((b, i) => (
            <motion.li
              key={(b.text ?? "") + i}
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={reduce ? { duration: 0.2 } : { type: "spring", bounce: 0, duration: 0.5, delay: 0.25 + i * 0.12 }}
              className="flex items-center gap-3 rounded-[14px] bg-white/[0.05] px-3.5 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
            >
              <span className={"grid size-8 shrink-0 place-items-center rounded-[10px] " + (b.mark === "win" ? "bg-orange/[0.16] text-[#ffc266]" : "bg-[rgba(165,148,255,0.14)] text-[#c4b8ff]")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  {ICON[b.mark ?? ""] ?? ICON.skill}
                </svg>
              </span>
              <span className="text-[15px] font-medium leading-snug text-label">{inline(b.text)}</span>
            </motion.li>
          ))}
        </ul>
      )}
    </article>
  );
};

