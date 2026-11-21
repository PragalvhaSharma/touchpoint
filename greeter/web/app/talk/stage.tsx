"use client";

// The playground for the voice's screen: type what the voice would ask show for, and the screen builds the
// same way it does beside Prag's live voice. For tests, and the demo's fallback when there's no voice.
import { useState } from "react";
import { Screen, useScreen } from "./genui/screen";

export default function Stage() {
  const screen = useScreen();
  const [ask, setAsk] = useState("");
  const building = !!screen.current?.streaming;

  return (
    <main className="relative isolate flex h-dvh flex-col overflow-hidden bg-bg">
      <div className="flex min-h-0 flex-1 items-stretch justify-center px-4 pt-4 lg:px-8 lg:pt-8">
        <Screen screen={screen} className="h-full w-full max-w-[1180px]" />
        {!screen.current && (
          <p className="self-center text-balance text-center text-[15px] leading-[1.45] text-label-3">
            Type what the voice would show.
          </p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const t = ask.trim();
          if (!t) return;
          setAsk("");
          void screen.show(t);
        }}
        className="flex justify-center px-4 pb-5 pt-4 lg:pb-8"
      >
        <div className="glass flex w-full max-w-[480px] items-center gap-2 rounded-full py-1.5 pl-5 pr-1.5 focus-within:ring-2 focus-within:ring-blue/60">
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder="Show me Evan Lin's chip"
            aria-label="What to show"
            enterKeyHint="send"
            autoComplete="off"
            autoFocus
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] outline-none placeholder:text-label-3"
          />
          <button
            type="submit"
            aria-label="Show it"
            disabled={!ask.trim()}
            className="press grid size-9 shrink-0 place-items-center rounded-full bg-blue text-white disabled:bg-raised-2 disabled:text-label-3"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
        <span role="status" className="sr-only">{building ? "Building the screen" : ""}</span>
      </form>
    </main>
  );
}
