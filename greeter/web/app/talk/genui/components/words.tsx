"use client";

// The moments made of type: a quote set large, arriving word by word as if said aloud, and one number
// counting up to itself. Each carries a single thing; where it came from is a small mark.
import { motion, useReducedMotion } from "motion/react";
import type * as S from "../schema";
import { SourceMark, clamp, domain, useAge, useBox, useCount, type View } from "./base";

export const QuoteMomentView: View<typeof S.QuoteMoment> = ({ props }) => {
  const reduce = useReducedMotion();
  const age = useAge();
  const [ref, { w, h }] = useBox<HTMLElement>();
  const text = (props.text ?? "").trim().replace(/^["“]+|["”]+$/g, "");
  const words = text.split(/\s+/).filter(Boolean);
  // As large as the space allows: about 22 characters a line, and the lines it takes fitting the height.
  const chars = Math.max(12, text.length);
  const byWidth = (w * 0.86) / (Math.min(chars, 22) * 0.52);
  const byHeight = Math.sqrt((h * 0.62 * w * 0.86) / (chars * 0.52 * 1.2));
  const size = clamp(24, Math.min(byWidth, byHeight), 72);
  const hang = w >= 560;
  return (
    <figure ref={ref} className="relative flex h-full w-full flex-col justify-center" style={{ paddingLeft: hang ? size * 1.5 : 0 }}>
      <motion.svg
        aria-hidden
        viewBox="0 0 40 32"
        className={"text-blue " + (hang ? "absolute left-0" : "")}
        style={hang ? { width: size * 1.05, height: size * 0.84, top: `calc(50% - ${size * 0.84}px - ${size * 0.3}px)` } : { width: size * 0.9, height: size * 0.72, marginBottom: size * 0.4 }}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", bounce: 0, duration: 0.4 }}
      >
        <path
          fill="currentColor"
          d="M0 32V19.6C0 8.9 5.1 2.4 15.4 0l1.9 4.1C11.6 5.8 8.7 9.5 8.3 15.2H16V32H0Zm22.4 0V19.6C22.4 8.9 27.5 2.4 37.8 0l1.9 4.1C34 5.8 31.1 9.5 30.7 15.2h7.7V32H22.4Z"
        />
      </motion.svg>
      <blockquote className="max-w-[24ch] text-pretty font-semibold text-white" style={{ fontSize: size, lineHeight: 1.14, letterSpacing: "-0.028em" }}>
        <span className="sr-only">{text}</span>
        <span aria-hidden>
          {words.map((wd, i) => (
            <motion.span
              key={i}
              className="inline-block"
              initial={reduce ? { opacity: 0 } : { opacity: 0, filter: "blur(8px)", y: 4 }}
              animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
              // Words that stream in late join the reading pace instead of waiting their turn from zero.
              transition={reduce ? { duration: 0.2 } : { duration: 0.5, ease: [0.23, 1, 0.32, 1], delay: Math.max(0, 0.1 + i * 0.045 - age()) }}
            >
              {wd}
              {i < words.length - 1 ? "\u00a0" : ""}
            </motion.span>
          ))}
        </span>
      </blockquote>
      {(props.source || props.site) && (
        <motion.figcaption
          style={{ marginTop: clamp(18, size * 0.6, 36) }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: reduce ? 0 : Math.min(1.6, 0.3 + words.length * 0.045) }}
        >
          <SourceMark href={props.source} label={props.site || domain(props.source)} className={size > 44 ? "text-[15px]" : ""} />
        </motion.figcaption>
      )}
    </figure>
  );
};

/** "1,422" -> 1422; "1.4k" -> 1.4 + "k"; "$720" -> "$" + 720; "#1" -> "#" + 1. */
function parse(v: unknown): { pre: string; n: number | null; post: string; places: number; grouped: boolean } {
  const s = String(v ?? "").trim();
  const m = s.match(/^([^\d-]*?)(-?[\d,]*\.?\d+)(.*)$/);
  if (!m) return { pre: "", n: null, post: s, places: 0, grouped: false };
  const raw = m[2].replace(/,/g, "");
  const places = raw.includes(".") ? raw.split(".")[1].length : 0;
  return { pre: m[1], n: Number(raw), post: m[3], places, grouped: m[2].includes(",") || Number(raw) >= 10000 };
}

export const BigNumberView: View<typeof S.BigNumber> = ({ props }) => {
  const reduce = useReducedMotion();
  const [ref, { w, h }] = useBox<HTMLElement>();
  const v = parse(props.value);
  const shown = useCount(v.n, 1.5);
  const text =
    v.n == null
      ? ""
      : v.places
        ? shown.toFixed(v.places)
        : v.grouped
          ? Math.round(shown).toLocaleString("en-US")
          : String(Math.round(shown));
  const label = (props.label ?? "").split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
  // The final figure sets the size, so it never grows while it counts.
  const final = (v.pre + (v.n == null ? v.post : v.places ? v.n.toFixed(v.places) : v.grouped ? v.n.toLocaleString("en-US") : String(v.n)) + (v.n != null ? v.post : "")).length;
  const beside = w >= 560;
  const size = clamp(88, Math.min(((beside ? w * 0.64 : w * 0.96) / Math.max(1, final)) * 1.7, h * (beside ? 0.62 : 0.5)), 320);
  const labelSize = clamp(20, size * 0.16, 38);
  return (
    <figure ref={ref} className="flex h-full w-full items-center justify-center">
      <p className="sr-only">
        {String(props.value ?? "")} {label}
      </p>
      <div className={"flex " + (beside ? "items-end" : "flex-col items-start")} style={{ gap: beside ? size * 0.16 : size * 0.14 }}>
        <motion.p
          aria-hidden
          className="whitespace-nowrap font-bold tabular-nums text-white"
          style={{ fontSize: size, lineHeight: 0.8, letterSpacing: "-0.045em" }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, filter: "blur(12px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          transition={{ duration: 0.7, ease: [0.23, 1, 0.32, 1] }}
        >
          {v.pre && <span className="mr-[0.04em] align-top text-[0.5em] font-semibold text-label-2">{v.pre}</span>}
          {text || v.post}
          {v.n != null && v.post && <span className="ml-[0.04em] text-[0.62em] tracking-[-0.03em] text-label-2">{v.post.trim()}</span>}
        </motion.p>
        <figcaption aria-hidden className="flex flex-col gap-3" style={{ paddingBottom: beside ? size * 0.02 : 0 }}>
        <motion.span
          className="max-w-[11ch] text-balance font-semibold leading-[1.1] tracking-[-0.02em] text-label-2"
          style={{ fontSize: labelSize }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ type: "spring", bounce: 0, duration: 0.5, delay: reduce ? 0 : 0.5 }}
        >
          {label}
        </motion.span>
          {props.source && <SourceMark href={props.source} />}
        </figcaption>
      </div>
    </figure>
  );
};
