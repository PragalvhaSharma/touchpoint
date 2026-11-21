"use client";

// Who you are talking to: their photo, as large as the space allows, coming into focus the way the camera
// found them and lit by its own colours. The name is the only text. With room beside the photo the name
// stands there like a film credit; otherwise it rests on the photo's lower edge.
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type * as S from "../schema";
import { EASE_OUT, Glow, Picture, SETTLE, clamp, initials, useBox, usePhotos, type View } from "./base";

export const PortraitView: View<typeof S.Portrait> = ({ props }) => {
  const reduce = useReducedMotion();
  const [ref, { w, h }] = useBox<HTMLElement>();
  const name = (props.name ?? "").trim();
  const srcs = usePhotos(name, [props.photo, ...(Array.isArray(props.images) ? props.images : [])], true);
  const [shown, setShown] = useState<string | null>(null);
  const words = name.split(/\s+/).filter(Boolean);
  const longest = Math.max(4, ...words.map((x) => x.length));

  // Beside: the photo takes the height and the name the rest of the width, when the name still reads large.
  const besideH = Math.min(h, (w * 0.56) / 0.8);
  const nameRoom = w - besideH * 0.8 - w * 0.06;
  const besideFont = Math.min(nameRoom / (longest * 0.56), (besideH * 0.8) / (words.length * 1.05), 132);
  const beside = w >= 520 && w / Math.max(1, h) > 1.1 && besideFont >= 52;
  const ph = beside ? besideH : Math.min(h, (w / 0.8));
  const pw = ph * 0.8;
  const font = beside ? besideFont : clamp(30, Math.min(pw / (longest * 0.62), pw * 0.15), 76);

  return (
    <figure ref={ref} className="relative isolate flex h-full w-full items-center justify-center" style={{ gap: w * 0.06 }}>
      {w > 0 && (
        <>
          <div className="relative shrink-0" style={{ width: pw, height: ph }}>
            <Glow src={shown} className="-inset-[14%] size-[128%] rounded-full" opacity={0.6} />
            <motion.div
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.05, filter: "blur(16px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              transition={reduce ? { duration: 0.25 } : SETTLE}
              className="relative size-full overflow-hidden bg-[linear-gradient(160deg,#2c2c2e,#1c1c1e)] shadow-[0_50px_90px_-40px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.06)]"
              style={{ borderRadius: clamp(24, pw * 0.08, 40) }}
            >
              <Picture
                srcs={srcs}
                alt={name}
                className="absolute inset-0"
                onReady={setShown}
                fallback={
                  <span className="font-bold tracking-[-0.02em] text-white/25" style={{ fontSize: pw * 0.34 }}>
                    {initials(name)}
                  </span>
                }
              />
              {!beside && (
                <>
                  {/* the shade only darkens where the letters sit */}
                  <div className="absolute inset-x-0 bottom-0 h-[46%] bg-gradient-to-t from-black/75 via-black/30 to-transparent" />
                  <figcaption className="absolute inset-x-0 bottom-0" style={{ padding: pw * 0.07 }}>
                    <Name words={words} reduce={!!reduce} size={font} />
                  </figcaption>
                </>
              )}
              <div className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]" />
            </motion.div>
          </div>
          {beside && (
            <figcaption className="min-w-0 self-end" style={{ paddingBottom: ph * 0.03, width: nameRoom }}>
              <Name words={words} reduce={!!reduce} size={font} stacked />
            </figcaption>
          )}
        </>
      )}
    </figure>
  );
};

function Name({ words, reduce, stacked, size }: { words: string[]; reduce: boolean; stacked?: boolean; size: number }) {
  return (
    <p className="font-bold text-white" style={{ fontSize: size, lineHeight: 0.95, letterSpacing: "-0.04em" }}>
      {words.map((w, i) => (
        <span key={i} className={(stacked ? "block " : "inline-block ") + "overflow-hidden pb-[0.08em] align-bottom"}>
          <motion.span
            className="inline-block"
            initial={reduce ? { opacity: 0 } : { y: "105%" }}
            animate={reduce ? { opacity: 1 } : { y: "0%" }}
            transition={reduce ? { duration: 0.25 } : { duration: 0.8, ease: EASE_OUT, delay: 0.35 + i * 0.08 }}
          >
            {w}
            {!stacked && i < words.length - 1 ? " " : ""}
          </motion.span>
        </span>
      ))}
    </p>
  );
}
