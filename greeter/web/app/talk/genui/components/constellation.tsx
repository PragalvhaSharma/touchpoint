"use client";

// A crowd at a glance: everyone as a face, gathered into the groups they share (one word each), the person
// it is about lit and named. Each group packs outward from its centre along a sunflower spiral so no two
// faces touch, sits in its own faint pool of light, and the whole is sized to fill the space it is given.
import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import type * as S from "../schema";
import { PersonFace, clamp, each, firstName, useBox, type View } from "./base";

type One = { name: string; group?: string; photo?: string | null };
type Placed = { x: number; y: number; p: One; on: boolean; size: number };
type Cluster = { g: string; placed: Placed[]; w: number; h: number; cx: number; cy: number };
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Biggest first, each at the first spot along the spiral that touches nothing already placed. */
function pack(g: string, members: { p: One; on: boolean; size: number }[], gap: number): Cluster {
  const placed: Placed[] = [];
  // a lit face carries its name under it, so it claims a little more room below
  const below = (q: { on: boolean; size: number }) => (q.on ? q.size * 0.22 : 0);
  for (const m of [...members].sort((a, b) => b.size - a.size)) {
    const step = Math.max(2, m.size * 0.1);
    for (let k = 0; k < 4000; k++) {
      const rad = step * Math.sqrt(k);
      const a = k * GOLDEN;
      const x = rad * Math.cos(a), y = rad * Math.sin(a) * 0.9;
      const ok = placed.every((q) => Math.hypot(q.x - x, q.y + below(q) - (y + below(m))) >= (q.size + m.size) / 2 + gap + (q.on || m.on ? gap : 0));
      if (ok) {
        placed.push({ x, y, ...m });
        break;
      }
    }
  }
  let top = 0, bottom = 0, left = 0, right = 0;
  for (const q of placed) {
    top = Math.min(top, q.y - q.size / 2);
    bottom = Math.max(bottom, q.y + q.size / 2 + (q.on ? q.size * 0.42 : 0));
    left = Math.min(left, q.x - q.size / 2);
    right = Math.max(right, q.x + q.size / 2);
  }
  return { g, placed, w: right - left, h: bottom - top, cx: -(left + right) / 2, cy: -(top + bottom) / 2 };
}

type Layout = { size: number; clusters: { c: Cluster; x: number; y: number }[]; height: number; label: number };

/** The largest face size at which every group fits the box, laid out in rows. */
function layout(groups: [string, One[]][], lit: Set<string>, w: number, h: number): Layout | null {
  for (let size = 88; size >= 26; size -= 2) {
    const big = Math.round(size * 1.55);
    const gap = Math.max(5, size * 0.16);
    const label = groups.some(([g]) => g) ? clamp(36, size * 0.62, 52) : 0;
    const clusters = groups.map(([g, ms]) => pack(g, ms.map((p) => ({ p, on: lit.has(p.name.toLowerCase()), size: lit.has(p.name.toLowerCase()) ? big : size })), gap));
    const between = clamp(28, size * 0.9, 80);
    const cwOf = (c: Cluster) => Math.max(c.w, label * 2.6);
    // as few rows as fit the width, with the groups shared evenly between them
    let rows: Cluster[][] = [];
    for (let r = 1; r <= clusters.length; r++) {
      const per = Math.ceil(clusters.length / r);
      const tryRows = Array.from({ length: r }, (_, i) => clusters.slice(i * per, i * per + per)).filter((x) => x.length);
      if (tryRows.every((row) => row.reduce((a, c) => a + cwOf(c), 0) + between * (row.length - 1) <= w)) {
        rows = tryRows;
        break;
      }
    }
    if (!rows.length) continue;
    const rowH = rows.map((r) => label + Math.max(...r.map((c) => c.h)));
    const height = rowH.reduce((a, b) => a + b, 0) + between * 0.8 * (rows.length - 1);
    const widest = Math.max(...rows.map((r) => r.reduce((a, c) => a + Math.max(c.w, label * 2.6), 0) + between * (r.length - 1)));
    if (height > h || widest > w) continue;
    // centre each row across, and the whole block down the box
    const out: Layout["clusters"] = [];
    let y = (h - height) / 2;
    rows.forEach((r, ri) => {
      const rw = r.reduce((a, c) => a + Math.max(c.w, label * 2.6), 0) + between * (r.length - 1);
      // spread a row's groups over the width when there is room to spare
      const extra = r.length > 1 ? Math.min((w - rw) / (r.length + 1), between * 2) : 0;
      let x = (w - rw - extra * (r.length - 1)) / 2;
      for (const c of r) {
        const cw = Math.max(c.w, label * 2.6);
        out.push({ c, x: x + cw / 2, y: y + label + (rowH[ri] - label) / 2 });
        x += cw + between + extra;
      }
      y += rowH[ri] + between * 0.8;
    });
    return { size, clusters: out, height, label };
  }
  return null;
}

export const ConstellationView: View<typeof S.Constellation> = ({ props }) => {
  const reduce = useReducedMotion();
  const [ref, { w, h }] = useBox<HTMLDivElement>();
  const all = each(props.people as One[] | undefined, (p) => !!p.name?.trim()).slice(0, 40);
  const lit = new Set(each(props.highlight as string[] | undefined).map((s) => s.trim().toLowerCase()));

  const groups = new Map<string, One[]>();
  for (const p of all) {
    const g = (p.group ?? "").trim();
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(p);
  }
  // the group the lit people are in comes first
  const ordered = [...groups].sort(([, a], [, b]) => Number(b.some((p) => lit.has(p.name.toLowerCase()))) - Number(a.some((p) => lit.has(p.name.toLowerCase()))));
  const key = JSON.stringify([ordered.map(([g, ms]) => [g, ms.map((p) => p.name)]), [...lit], w, h]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key holds everything the layout reads
  const L = useMemo(() => (w > 0 && h > 0 ? layout(ordered, lit, w, Math.max(h, 260)) ?? layout(ordered, lit, w, 4000) : null), [key]);

  return (
    <div ref={ref} className="relative h-full w-full select-none" style={{ minHeight: 260 }}>
      {L &&
        L.clusters.map(({ c, x, y }, gi) => {
          const ox = x + c.cx, oy = y + c.cy;
          const pool = Math.max(c.w, c.h) / 2 + L.size * 0.7;
          const hasLit = c.placed.some((q) => q.on);
          return (
            <div key={c.g || "everyone"}>
              {/* the group's own faint light, so it reads as one */}
              <motion.span
                aria-hidden
                className="absolute rounded-full"
                style={{
                  left: x - pool,
                  top: y - pool,
                  width: pool * 2,
                  height: pool * 2,
                  background: hasLit
                    ? "radial-gradient(closest-side, rgba(10,132,255,0.16), rgba(10,132,255,0.05) 55%, transparent)"
                    : "radial-gradient(closest-side, rgba(235,235,245,0.08), rgba(235,235,245,0.025) 55%, transparent)",
                }}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "spring", bounce: 0, duration: 1, delay: reduce ? 0 : gi * 0.1 }}
              />
              {c.g && (
                <motion.p
                  className="absolute -translate-x-1/2 whitespace-nowrap font-semibold tracking-[-0.015em] text-white"
                  style={{ left: x, top: y - c.h / 2 - L.label, fontSize: clamp(15, L.size * 0.36, 22) }}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.45, ease: [0.23, 1, 0.32, 1], delay: reduce ? 0 : 0.1 + gi * 0.1 }}
                >
                  {c.g}
                  <span className="ml-2 font-medium tabular-nums text-label-3">{c.placed.length}</span>
                </motion.p>
              )}
              {c.placed.map((q, k) => {
                const delay = reduce ? 0 : 0.2 + gi * 0.1 + Math.sqrt(k) * 0.09;
                return (
                  <motion.div
                    key={q.p.name + k}
                    className="absolute flex flex-col items-center"
                    style={{ left: ox + q.x - q.size / 2, top: oy + q.y - q.size / 2, width: q.size, zIndex: q.on ? 2 : 1 }}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6, x: -q.x * 0.5, y: -q.y * 0.5 }}
                    animate={{ opacity: q.on || !lit.size ? 1 : 0.8, scale: 1, x: 0, y: 0 }}
                    transition={reduce ? { duration: 0.25 } : { type: "spring", bounce: 0, duration: 0.8, delay }}
                    title={q.p.name}
                  >
                    <PersonFace name={q.p.name} photo={q.p.photo} size={q.size} className={q.on ? "ring-2 ring-blue ring-offset-4 ring-offset-black/0" : ""} />
                    {q.on && (
                      <span className="mt-2.5 whitespace-nowrap font-semibold text-white" style={{ fontSize: clamp(13, q.size * 0.2, 18) }}>
                        {firstName(q.p.name)}
                      </span>
                    )}
                  </motion.div>
                );
              })}
            </div>
          );
        })}
      <ul className="sr-only">
        {all.map((p, i) => (
          <li key={i}>
            {p.name}
            {p.group ? `, ${p.group}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
};
