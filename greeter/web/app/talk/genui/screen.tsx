"use client";

// The screen the voice builds while it talks. useScreen() owns one request at a time: it streams OpenUI Lang
// from /api/talk/ui into GenCanvas, and a new request replaces the last. <Screen> is the glass stage it
// shows on; where it sits is up to the page (className), and it is gone when there is nothing to show.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GenCanvas } from "./canvas";

const SPRING = { type: "spring", bounce: 0, duration: 0.4 } as const;

export type Shown = { key: number; request: string; text: string; streaming: boolean; error?: string };
export type ScreenHandle = {
  show: (request: string, personId?: string) => Promise<void>;
  clear: () => void;
  current: Shown | null;
};

export function useScreen(): ScreenHandle {
  const [current, setCurrent] = useState<Shown | null>(null);
  const building = useRef<AbortController | null>(null);
  const seq = useRef(0);

  const show = useCallback(async (request: string, personId?: string) => {
    building.current?.abort();
    const ac = new AbortController();
    building.current = ac;
    const key = ++seq.current;
    const t0 = performance.now();
    let text = "";
    setCurrent({ key, request, text, streaming: true });
    try {
      // the server looks the person up itself: one round trip before the model starts, not two
      const r = await fetch("/api/talk/ui", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(personId ? { request, personId } : { request }),
        signal: ac.signal,
      });
      if (!r.ok || !r.body) throw new Error((await r.text().catch(() => "")) || `the screen builder answered ${r.status}`);
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!text) console.info(`[screen] first bytes ${Math.round(performance.now() - t0)} ms after "${request}"`);
        text += value;
        setCurrent((s) => (s?.key === key ? { ...s, text } : s));
      }
      setCurrent((s) => (s?.key === key ? { ...s, streaming: false } : s));
    } catch (e) {
      if (ac.signal.aborted) return;
      const error = String((e as Error).message ?? e).slice(0, 160);
      setCurrent((s) => (s?.key === key ? { ...s, streaming: false, error } : s));
    }
  }, []);

  const clear = useCallback(() => {
    seq.current++;
    building.current?.abort();
    building.current = null;
    setCurrent(null);
  }, []);

  useEffect(() => () => building.current?.abort(), []);

  return useMemo(() => ({ show, clear, current }), [show, clear, current]);
}

export function Screen({ screen, className = "" }: { screen: ScreenHandle; className?: string }) {
  const reduce = useReducedMotion();
  const { current, clear } = screen;
  const up = current !== null;

  // Escape puts the screen away.
  useEffect(() => {
    if (!up) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && clear();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [up, clear]);

  return (
    <AnimatePresence>
      {current && (
        <motion.section
          key="screen"
          aria-label="What the greeter is showing"
          aria-busy={current.streaming}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, filter: "blur(10px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, filter: "blur(8px)", transition: { duration: 0.2 } }}
          transition={SPRING}
          // a deeper glass than the chips around it: the moment reads over a live camera
          className={"glass pointer-events-auto relative flex min-h-0 flex-col overflow-hidden rounded-[28px] [--glass:rgba(16,16,18,0.76)] " + className}
        >
          <button
            type="button"
            onClick={clear}
            aria-label="Put the screen away"
            className="press absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-full bg-white/10 text-label-2 hover:bg-white/20 hover:text-label"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <div className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto p-5 sm:p-8">
            <GenCanvas response={current.text} streaming={current.streaming} />
            {current.error && <p className="mt-4 text-[14px] leading-[1.45] text-label-2">Couldn&apos;t build that screen: {current.error}</p>}
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
