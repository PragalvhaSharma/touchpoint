"use client";

// People this person should know, drawn as lines out from them: one curved line to each face, and on the
// line the one word they share. The best match is the lit line. Laid out in pixels to fill its space.
import { motion, useReducedMotion } from "motion/react";
import type * as S from "../schema";
import { EASE_OUT, PersonFace, clamp, each, firstName, useBox, type Pt, type View } from "./base";

type Who = { name: string; word?: string; photo?: string | null; where?: string };

/** Cubic from a to b that leaves level and arrives level: the S of a line reaching out. */
function curve(a: Pt, b: Pt) {
  const c1 = { x: a.x + (b.x - a.x) * 0.55, y: a.y };
  const c2 = { x: a.x + (b.x - a.x) * 0.45, y: b.y };
  return { d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`, c1, c2 };
}

function length(a: Pt, c1: Pt, c2: Pt, b: Pt) {
  let len = 0;
  let p = a;
  for (let i = 1; i <= 24; i++) {
    const t = i / 24, u = 1 - t;
    const q = { x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y };
    len += Math.hypot(q.x - p.x, q.y - p.y);
    p = q;
  }
  return len;
}

/** The shared word, as much of it as fits on its stretch of line. */
function fit(word: string, room: number, px: number) {
  const words = word.trim().split(/\s+/).slice(0, 2);
  while (words.length > 1 && words.join(" ").length * px * 0.58 > room) words.pop();
  return words.join(" ");
}

export const FacesView: View<typeof S.Faces> = ({ props }) => {
  const reduce = useReducedMotion();
  const [ref, { w, h: boxH }] = useBox<HTMLDivElement>();
  const people = each(props.people as Who[] | undefined, (p) => !!p.name?.trim()).slice(0, 5);
  const n = Math.max(1, people.length);
  const wide = w >= 520;
  const h = Math.max(boxH, wide ? 300 : n * 82 + 40);

  // Faces grow with the space: the person at the root, the others on an arc around them.
  const me = clamp(84, Math.min(w * 0.19, h * 0.3), 176);
  const them = clamp(52, Math.min((h - 40) / (n * 1.45), w * (wide ? 0.11 : 0.17)), 112);
  const nameSize = clamp(13, them * 0.21, 20);
  const wordSize = clamp(12.5, them * 0.17, 16);
  const labelW = wide ? clamp(130, w * 0.2, 220) : them + 60;

  const c: Pt = { x: wide ? Math.max(me * 0.7, w * 0.13) : me / 2 + 4, y: h / 2 - (wide ? 0 : 12) };
  const reach = w - (wide ? labelW + them * 0.6 : labelW / 2 + 4) - c.x;
  const spread = h / 2 - them * 0.75 - (wide ? 8 : 26);
  const tilt = n <= 2 ? 0.5 : 0.95;
  const at = (i: number): Pt => {
    const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
    const angle = t * tilt;
    return { x: c.x + reach * (wide ? 0.72 + 0.28 * Math.cos(angle) : 0.84 + 0.16 * Math.cos(angle)), y: c.y + (n === 1 ? 0 : spread * (Math.sin(angle) / Math.sin(tilt))) };
  };

  return (
    <div ref={ref} className="relative h-full w-full select-none" style={{ minHeight: wide ? 300 : n * 82 + 40 }}>
      {w > 0 && (
        <>
          <svg width={w} height={h} className="absolute inset-0 overflow-visible" aria-hidden>
            {people.map((p, i) => {
              const b = at(i);
              const { d, c1, c2 } = curve(c, b);
              const len = length(c, c1, c2, b);
              const lit = i === 0;
              const id = `faces-line-${i}`;
              const room = len - me / 2 - them / 2;
              // motion draws with pathLength=1 on the path, so the offset along it is a share, not pixels
              const startOffset = `${((me / 2 + room * 0.66) / len) * 100}%`;
              const delay = 0.15 + i * 0.12;
              return (
                <g key={i}>
                  <motion.path
                    id={id}
                    d={d}
                    fill="none"
                    stroke={lit ? "var(--blue)" : "rgba(235,235,245,0.24)"}
                    strokeWidth={lit ? 2 : 1.4}
                    strokeLinecap="round"
                    initial={reduce ? { opacity: 0 } : { pathLength: 0 }}
                    animate={reduce ? { opacity: 1 } : { pathLength: 1 }}
                    transition={reduce ? { duration: 0.3 } : { duration: 0.8, ease: EASE_OUT, delay }}
                  />
                  {p.word && (
                    <motion.text
                      dy={-wordSize * 0.6}
                      fontSize={wordSize}
                      fontWeight={600}
                      fill={lit ? "#64b5ff" : "rgba(235,235,245,0.66)"}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.4, ease: "easeOut", delay: reduce ? 0 : delay + 0.5 }}
                    >
                      <textPath href={`#${id}`} startOffset={startOffset} textAnchor="middle">
                        {fit(p.word, room - 16, wordSize)}
                      </textPath>
                    </motion.text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* The person, at the root of every line. */}
          <motion.div
            className="absolute flex flex-col items-center"
            style={{ left: c.x - me / 2, top: c.y - me / 2, width: me }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, filter: "blur(6px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            transition={reduce ? { duration: 0.25 } : { type: "spring", bounce: 0, duration: 0.5 }}
          >
            <PersonFace name={props.name} photo={props.photo} size={me} />
            <span className="mt-3 whitespace-nowrap font-semibold text-label" style={{ fontSize: clamp(14, me * 0.12, 20) }}>
              {firstName(props.name)}
            </span>
          </motion.div>

          {people.map((p, i) => {
            const b = at(i);
            const delay = 0.15 + i * 0.12 + 0.6;
            return (
              <motion.div
                key={p.name + i}
                className={"absolute flex " + (wide ? "items-center" : "flex-col items-center text-center")}
                style={
                  wide
                    ? { left: b.x - them / 2, top: b.y - them / 2, width: them + labelW, gap: them * 0.22 }
                    : { left: b.x - labelW / 2, top: b.y - them / 2, width: labelW }
                }
                initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, filter: "blur(6px)" }}
                animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                transition={reduce ? { duration: 0.25 } : { type: "spring", bounce: 0, duration: 0.5, delay }}
              >
                <PersonFace name={p.name} photo={p.photo} size={them} className={i === 0 ? "ring-2 ring-blue ring-offset-[3px] ring-offset-black/60" : ""} />
                <span className={"flex min-w-0 flex-col " + (wide ? "" : "mt-2 items-center")}>
                  <span className="line-clamp-2 break-words font-semibold leading-[1.15] tracking-[-0.01em] text-label" style={{ fontSize: nameSize }}>
                    {p.name}
                  </span>
                  {p.where && (
                    <span className="mt-1 font-medium text-label-3" style={{ fontSize: nameSize * 0.8 }}>
                      {p.where}
                    </span>
                  )}
                </span>
              </motion.div>
            );
          })}
        </>
      )}
      <ul className="sr-only">
        {people.map((p, i) => (
          <li key={i}>
            {p.name}
            {p.word ? `: ${p.word}` : ""}
            {p.where ? `, ${p.where}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
};
