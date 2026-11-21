"use client";

// The screen the voice builds. Give it the cumulative OpenUI Lang text of the current request; when a
// response arrives that doesn't continue the shown one, it is a new screen: the old one recedes and the
// new one builds in its place. An empty response keeps the last screen up until the next one starts.
import { Renderer, type ParseResult } from "@openuidev/react-lang";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useState } from "react";
import { SPRING } from "./components/base";
import { library } from "./library";

type Screen = { key: number; text: string };

export function GenCanvas({ response, streaming }: { response: string; streaming: boolean }) {
  const reduce = useReducedMotion();
  const [screen, setScreen] = useState<Screen>({ key: 0, text: response ?? "" });
  const [drawn, setDrawn] = useState<number | null>(null);

  // Adjust during render (React's pattern for state derived from a changing prop): no extra frame.
  const next = response ?? "";
  if (next && next !== screen.text) {
    setScreen(next.startsWith(screen.text) && screen.text ? { key: screen.key, text: next } : { key: screen.key + 1, text: next });
  }

  const key = screen.key;
  const onParse = useCallback((r: ParseResult | null) => {
    if (r?.root) setDrawn((d) => (d === key ? d : key));
  }, [key]);
  const waiting = streaming && drawn !== key;

  return (
    // A container, so every moment lays itself out for the width it is given, not the window's.
    <div className="@container relative h-full min-h-0 w-full">
      <AnimatePresence mode="popLayout" initial={false}>
        {screen.text && (
          <motion.div
            key={screen.key}
            // the renderer wraps the program in two plain boxes: they pass the full height through
            className="h-full w-full [&>div]:h-full [&>div>div]:h-full"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)", y: 0 }}
            exit={reduce ? { opacity: 0, transition: { duration: 0.15 } } : { opacity: 0, scale: 0.96, y: -16, filter: "blur(10px)", transition: { ...SPRING, duration: 0.3 } }}
            transition={reduce ? { duration: 0.2 } : SPRING}
            style={{ transformOrigin: "50% 0%" }}
          >
            <Renderer response={screen.text} library={library} isStreaming={streaming} onParseResult={onParse} onError={onError} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {waiting && (
          <motion.div
            key="waiting"
            aria-live="polite"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.3, delay: 0.2 }}
            className="pointer-events-none absolute inset-x-0 top-0 h-[280px]"
          >
            <span className="sr-only">Building the screen</span>
            {/* The voice's own light, gathering where the screen will appear. */}
            <span
              aria-hidden
              className="absolute left-[8%] top-[10%] size-[220px] animate-pulse rounded-full bg-blue/25 blur-[80px] motion-reduce:animate-none"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function onError(errors: unknown[]) {
  if (errors.length && process.env.NODE_ENV !== "production") console.debug("genui", errors);
}
