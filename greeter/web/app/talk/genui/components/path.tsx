"use client";

// How someone got here, as one line drawn through the moments that mattered. The line climbs toward now,
// brightening into the voice's blue at the mark that is lit. Wide, it runs left to right; narrow, it runs down.
import { motion, useReducedMotion } from "motion/react";
import type * as S from "../schema";
import { EASE_IN_OUT, clamp, each, through, useBox, type Pt, type View } from "./base";

type Step = { when?: string; what: string; now?: boolean };

export const PathView: View<typeof S.Path> = ({ props }) => {
  const reduce = useReducedMotion();
  const [ref, { w, h: boxH }] = useBox<HTMLDivElement>();
  const steps = each(props.steps as Step[] | undefined, (s) => !!s.what?.trim()).slice(0, 6);
  const n = steps.length;
  const marked = steps.findIndex((s) => s.now);
  const lit = marked >= 0 ? marked : n - 1;
  const wide = w >= 560;

  const what = wide ? clamp(18, Math.min(w / (n * 7.5), boxH * 0.05), 30) : clamp(17, boxH / (n * 5), 22);
  const label = what * 2.6 + 14; // the words under a mark
  let pts: Pt[] = [];
  let h = boxH;
  if (wide) {
    const pad = Math.min(w * 0.1, w / (n * 2));
    const rise = clamp(60, (boxH - label) * 0.55, 300);
    const top = (boxH - rise - label) / 2 + 10;
    pts = steps.map((_, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1);
      // eases up: slow at first, then climbing
      return { x: pad + t * (w - pad * 2), y: top + rise - Math.pow(t, 1.35) * rise };
    });
  } else {
    const gap = clamp(84, (boxH - 40) / Math.max(1, n), 150);
    h = Math.max(boxH, n * gap);
    const top = (h - (n - 1) * gap) / 2;
    pts = steps.map((_, i) => {
      const t = n === 1 ? 0 : i / (n - 1);
      return { x: 14 + t * 12, y: top + i * gap };
    });
  }
  // The line runs a little past the first and last marks, so it reads as continuing.
  const lead: Pt[] = n
    ? wide
      ? [{ x: pts[0].x - 40, y: pts[0].y + 8 }, ...pts, { x: pts[n - 1].x + 40, y: pts[n - 1].y - 10 }]
      : [{ x: pts[0].x - 2, y: pts[0].y - 40 }, ...pts, { x: pts[n - 1].x + 2, y: pts[n - 1].y + 40 }]
    : [];
  const d = w ? through(lead, 0.5) : "";
  const DRAW = 1.4;
  const reach = (i: number) => (reduce ? 0 : 0.1 + DRAW * ((i + 1) / (n + 1)));
  const litAt = n > 1 ? (lit + 1) / (n + 1) : 0.5;

  return (
    <div ref={ref} className="relative h-full w-full" style={{ minHeight: wide ? 220 : n * 84 + 40 }}>
      {w > 0 && n > 0 && (
        <>
          <svg width={w} height={h} className="absolute inset-0 overflow-visible" aria-hidden>
            <defs>
              <linearGradient id="path-tone" x1={lead[0].x} y1={lead[0].y} x2={lead[lead.length - 1].x} y2={lead[lead.length - 1].y} gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="rgba(235,235,245,0)" />
                <stop offset="0.1" stopColor="rgba(235,235,245,0.3)" />
                <stop offset={Math.max(0.12, litAt - 0.22)} stopColor="rgba(235,235,245,0.55)" />
                <stop offset={litAt} stopColor="#0a84ff" />
                <stop offset="1" stopColor="rgba(10,132,255,0)" />
              </linearGradient>
            </defs>
            <motion.path
              d={d}
              fill="none"
              stroke="url(#path-tone)"
              strokeWidth={clamp(2, what * 0.1, 3)}
              strokeLinecap="round"
              initial={reduce ? { opacity: 0 } : { pathLength: 0 }}
              animate={reduce ? { opacity: 1 } : { pathLength: 1 }}
              transition={reduce ? { duration: 0.3 } : { duration: DRAW, ease: EASE_IN_OUT, delay: 0.1 }}
            />
          </svg>

          {steps.map((s, i) => {
            const p = pts[i];
            const on = i === lit;
            const dot = on ? what * 0.8 : what * 0.5;
            return (
              <motion.div
                key={i}
                className="absolute"
                style={{ left: p.x, top: p.y }}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={reduce ? { duration: 0.25 } : { type: "spring", bounce: 0, duration: 0.5, delay: reach(i) }}
              >
                <span
                  className={"absolute rounded-full " + (on ? "bg-blue shadow-[0_0_0_7px_rgba(10,132,255,0.18),0_0_30px_rgba(10,132,255,0.6)]" : "bg-white shadow-[0_0_0_5px_rgba(0,0,0,0.5)]")}
                  style={{ width: dot, height: dot, left: -dot / 2, top: -dot / 2 }}
                />
                <div
                  className={wide ? "absolute -translate-x-1/2 text-center" : "absolute"}
                  style={wide ? { top: what * 1.3, width: Math.min(260, w / Math.max(1, n) - 16) } : { top: -what * 0.7, left: what * 1.5, width: w - 60 }}
                >
                  <p className={"text-balance font-semibold leading-[1.15] tracking-[-0.015em] " + (on ? "text-white" : "text-label-2")} style={{ fontSize: what }}>
                    {s.what}
                  </p>
                  {s.when && (
                    <p className="mt-1 font-medium tabular-nums text-label-3" style={{ fontSize: clamp(13, what * 0.62, 17) }}>
                      {s.when}
                    </p>
                  )}
                </div>
              </motion.div>
            );
          })}
        </>
      )}
      <ol className="sr-only">
        {steps.map((s, i) => (
          <li key={i}>
            {s.when ? s.when + ": " : ""}
            {s.what}
          </li>
        ))}
      </ol>
    </div>
  );
};
