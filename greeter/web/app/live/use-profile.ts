"use client";

// Reads /api/talk/profile with the AI SDK's own stream reader: parseJsonEventStream turns the SSE into typed
// chunks, readUIMessageStream folds them into one message whose data parts are the cards. Transient "status"
// parts never land in the message, so they are caught on the way through.
import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, type UIMessageChunk } from "ai";
import { useEffect, useState } from "react";
import type { Profile, ProfileData, ProfileMessage } from "./types";

export type ProfileState = { id: string | null; profile: Profile; status: ProfileData["status"] | null; streaming: boolean; error: string | null };

const EMPTY: ProfileState = { id: null, profile: {}, status: null, streaming: false, error: null };

export function useProfile(id: string | null): ProfileState {
  const [state, setState] = useState<ProfileState>(EMPTY);
  // A new id (including the same person seen again after nobody) starts a fresh stream, reset during render.
  const [shown, setShown] = useState<string | null>(id);
  if (shown !== id) {
    setShown(id);
    setState({ ...EMPTY, id, streaming: !!id });
  }

  useEffect(() => {
    if (!id) return;
    const ac = new AbortController();
    // Each update starts from this person's state (a fresh one the first time), and none land after a switch.
    const update = (f: (s: ProfileState) => Partial<ProfileState>) => {
      if (ac.signal.aborted) return;
      setState((s) => {
        const base = s.id === id ? s : { ...EMPTY, id, streaming: true };
        return { ...base, ...f(base) };
      });
    };
    (async () => {
      try {
        const r = await fetch("/api/talk/profile?id=" + encodeURIComponent(id), { cache: "no-store", signal: ac.signal });
        if (!r.ok || !r.body) throw new Error(r.status === 404 ? "No profile for them yet." : "Couldn't read their profile.");
        const chunks = parseJsonEventStream({ stream: r.body, schema: uiMessageChunkSchema }).pipeThrough(
          new TransformStream<{ success: boolean; value?: unknown }, UIMessageChunk>({
            transform(res, out) {
              if (!res.success || !res.value) return;
              const chunk = res.value as UIMessageChunk;
              if (chunk.type === "data-status") {
                const data = (chunk as { data: ProfileData["status"] }).data;
                update(() => ({ status: data }));
              }
              out.enqueue(chunk);
            },
          }),
        );
        for await (const message of readUIMessageStream<ProfileMessage>({ stream: chunks })) {
          const profile: Profile = {};
          for (const part of message.parts) {
            if (part.type.startsWith("data-")) (profile as Record<string, unknown>)[part.type.slice(5)] = (part as { data: unknown }).data;
          }
          update(() => ({ profile }));
        }
        update(() => ({ streaming: false }));
      } catch (e) {
        if (ac.signal.aborted) return;
        const error = e instanceof Error ? e.message : "Couldn't read their profile.";
        update(() => ({ streaming: false, error }));
      }
    })();
    return () => ac.abort();
  }, [id]);

  // Until the first part arrives for a new person, they are loading.
  return id && state.id === id ? state : { ...EMPTY, id, streaming: !!id };
}

