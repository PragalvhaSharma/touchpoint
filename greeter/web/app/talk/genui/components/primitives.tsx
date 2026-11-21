"use client";

// The few plain parts a moment may lean on: the screen itself, side by side, one picture, a glance of text,
// and small marks. None of them is a card.
import { motion, useReducedMotion } from "motion/react";
import { useState, type ReactNode } from "react";
import type * as S from "../schema";
import { Glow, Picture, SETTLE, each, inline, isSrc, useBox, type View } from "./base";

type Node = { type?: unknown; typeName?: string; statementId?: string };
const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && (v as Node).type === "element";

// A moment takes the room it is given; marks and text keep their own height beside it.
const GROWS = new Set(["Portrait", "ProjectMoment", "Faces", "Path", "QuoteMoment", "BigNumber", "Constellation", "Image", "Grid"]);

/** Child statements in order, each arriving in turn. Unresolved references never hold an empty slot. */
function Sequence({ items, render, className, grow, fixed }: { items: unknown; render: (v: unknown) => ReactNode; className: string; grow: string; fixed: string }) {
  const reduce = useReducedMotion();
  const list = Array.isArray(items) ? items.filter(isNode) : [];
  return (
    <div className={className}>
      {list.map((c, i) => (
        <motion.div
          key={c.statementId ?? "i" + i}
          // each child is a container sized by its slot, so a moment lays itself out for exactly that space
          className={"min-w-0 " + (GROWS.has(c.typeName ?? "") ? grow : fixed)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduce ? 0.2 : 0.35, ease: "easeOut", delay: reduce ? 0 : [0, 0.16, 0.28][Math.min(i, 2)] }}
        >
          {render(c)}
        </motion.div>
      ))}
    </div>
  );
}

export const StackView: View<typeof S.Stack> = ({ props, renderNode }) => (
  <Sequence
    items={props.children}
    render={renderNode}
    className="flex h-full min-h-full flex-col justify-center gap-8 @lg:gap-10"
    grow="relative grid flex-1 min-h-[240px] grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] [container-type:size]"
    fixed="@container flex-none"
  />
);

export const GridView: View<typeof S.Grid> = ({ props, renderNode }) => (
  <Sequence
    items={props.children}
    render={renderNode}
    className={
      "grid h-full grid-cols-1 auto-rows-[minmax(240px,1fr)] gap-8 " +
      (props.columns === 3 ? "@xl:grid-cols-3 @xl:auto-rows-fr" : "@lg:grid-cols-2 @lg:auto-rows-fr")
    }
    grow="relative grid h-full min-h-[240px] grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] [container-type:size]"
    fixed="@container self-center"
  />
);

export const ImageView: View<typeof S.Image> = ({ props }) => {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState<string | null>(null);
  const [ref, { w, h }] = useBox<HTMLElement>();
  if (!isSrc(props.src)) return null;
  const ratio = { wide: 16 / 9, square: 1, tall: 4 / 5 }[props.shape ?? "wide"] ?? 16 / 9;
  const cap = props.caption ? 34 : 0;
  const iw = Math.min(w, (h - cap) * ratio);
  return (
    <figure ref={ref} className="relative isolate flex h-full w-full flex-col items-center justify-center">
      {w > 0 && (
        <motion.div
          className="relative"
          style={{ width: iw, height: iw / ratio }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.03, filter: "blur(12px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          transition={reduce ? { duration: 0.25 } : SETTLE}
        >
          <Glow src={shown} className="-inset-[8%] size-[116%] rounded-[40px]" opacity={0.4} />
          <Picture
            srcs={[props.src]}
            alt={props.alt ?? props.caption ?? ""}
            onReady={setShown}
            className="size-full rounded-[28px] bg-raised shadow-[0_40px_70px_-34px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.07)]"
          />
        </motion.div>
      )}
      {props.caption && <figcaption className="mt-3 text-[13px] font-medium text-label-3" style={{ width: iw }}>{props.caption}</figcaption>}
    </figure>
  );
};

export const TextView: View<typeof S.Text> = ({ props }) => {
  const size = props.size ?? "body";
  const cls =
    size === "title"
      ? "title text-balance text-[30px] font-bold tracking-[-0.028em] text-white @lg:text-[36px]"
      : size === "note"
        ? "text-[13px] font-medium leading-[1.4] text-label-3"
        : "max-w-[46ch] text-pretty text-[17px] leading-[1.45] text-label-2";
  return <p className={cls}>{inline(props.text)}</p>;
};

// ─── Marks ───────────────────────────────────────────────────────────────────

export const ICON: Record<string, ReactNode> = {
  win: <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4.5a2.5 2.5 0 0 0 2.6 3.4M17 6h2.5a2.5 2.5 0 0 1-2.6 3.4" />,
  school: <path d="M2.5 9 12 4.5 21.5 9 12 13.5 2.5 9zM6.5 11v4.6c1.6 1.5 3.4 2.2 5.5 2.2s3.9-.7 5.5-2.2V11M21.5 9v5" />,
  work: <path d="M3.5 8.5h17v11h-17zM8.5 8.5V6a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 15.5 6v2.5M3.5 13h17" />,
  code: <path d="m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5M13.5 5l-3 14" />,
  place: <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11zM12 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z" />,
  writing: <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" />,
  talk: <path d="M12 3.5a3 3 0 0 1 3 3V12a3 3 0 0 1-6 0V6.5a3 3 0 0 1 3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />,
  skill: <path d="M12 3.5 14.4 9l5.6.5-4.3 3.7 1.3 5.6L12 15.9l-5 2.9 1.3-5.6L4 9.5 9.6 9 12 3.5z" />,
};

export const BadgesView: View<typeof S.Badges> = ({ props }) => {
  const reduce = useReducedMotion();
  const items = each(props.items as { label: string; mark?: string }[] | undefined, (b) => !!b.label?.trim()).slice(0, 6);
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((b, i) => {
        const win = b.mark === "win";
        return (
          <motion.li
            key={b.label + i}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            transition={reduce ? { duration: 0.2 } : { type: "spring", bounce: 0, duration: 0.4, delay: [0, 0.05, 0.09, 0.12, 0.14, 0.16][i] }}
            className={
              "inline-flex items-center gap-2 rounded-full py-[7px] pl-3 pr-3.5 text-[14px] font-medium " +
              (win ? "bg-orange/[0.14] text-[#ffc266] shadow-[inset_0_0_0_1px_rgba(255,159,10,0.22)]" : "bg-white/[0.07] text-label shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]")
            }
          >
            {b.mark && ICON[b.mark] && (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={win ? "" : "text-label-2"}>
                {ICON[b.mark]}
              </svg>
            )}
            {b.label}
          </motion.li>
        );
      })}
    </ul>
  );
};
