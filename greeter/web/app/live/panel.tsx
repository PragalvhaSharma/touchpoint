"use client";

// The right side of the greeter. Who is in front of the camera, building itself card by card as their profile
// streams in (useProfile: AI SDK data parts), a live line that says what the greeter is doing right now, and,
// while the voice talks, the card for whatever it is talking about lifts and glows. The voice's own moment
// screens (OpenUI, ../talk/genui) land here too, as the "On screen" card, so nothing ever covers the camera.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import { Face, Glow, PersonFace } from "../talk/genui/components/base";
import { GenCanvas } from "../talk/genui/canvas";
import type { ScreenHandle, Shown } from "../talk/genui/screen";
import type { Voice } from "../voice";
import type { Org, Profile, RoleItem } from "./types";
import { useProfile } from "./use-profile";
import { RecruiterChip } from "./recruiter-chip";

const SPRING = { type: "spring", bounce: 0, duration: 0.5 } as const;

export type PanelVoice = Pick<Voice, "on" | "state" | "caption">;
export type PanelLine = { key: number; who: "person" | "greeter"; text: string };

type Props = {
  /** The known person to show; null when nobody (or only a guest) is in front of the camera. */
  personId: string | null;
  /** Talking with someone who isn't on the list. */
  guest: boolean;
  /** Everyone in the conversation, when it's a group. */
  members: { id: string; name: string }[];
  /** A face is in view that the greeter hasn't placed yet. */
  looking: boolean;
  /** How many Hack Western hackers the greeter knows by face (from its `people` event). */
  known?: number | null;
  connected: boolean;
  voice: PanelVoice;
  screen: ScreenHandle;
  lines: PanelLine[];
  footer: ReactNode;
  className?: string;
};

// ---------- what is happening ----------

/** One line of the status trail. A stand-in (shown until the real first step arrives) leaves no trace. */
type Phase = { label: string; live: boolean; stand?: boolean };

const esc = (s: string) => s.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");

// While a screen streams, a link (a face, a repo) arrives a character at a time; hold it back until its
// closing quote so it is fetched once, whole, and never as a run of half-typed 404s.
const settled = (text: string, streaming: boolean) => {
  if (!streaming) return text;
  const open = text.match(/"(?:\/|https?:)[^"]*$/);
  return open?.index != null ? text.slice(0, open.index) : text;
};

/** "Pragalvha Sharma's xAI hackathon win" -> "their xAI hackathon win". */
function topicOf(request: string | undefined, name: string): string | null {
  let t = request?.trim().replace(/[.!]+$/, "") ?? "";
  if (!t) return null;
  for (const n of [name, name.split(/\s+/)[0]].filter((x) => x && x.length > 1)) {
    t = t.replace(new RegExp("^" + esc(n) + "['’]s\\s+", "i"), "their ");
  }
  return t.length > 64 ? t.slice(0, 62).trim() + "…" : t;
}

function phaseOf(p: Props, streaming: boolean, status: string | null, named: string | null, topic: string | null): Phase {
  if (!p.connected) return { label: "Reconnecting to the greeter", live: true };
  if (p.personId) {
    if (streaming) return status ? { label: status, live: true } : { label: "Pulling up their profile", live: true, stand: true };
    const first = named ?? "them";
    const v = p.voice;
    if (v.on && v.state === "connecting") return { label: "Saying hi to " + first, live: true };
    if (v.on && v.state === "hearing") return { label: "Listening to " + first, live: true };
    if (v.on && v.state === "thinking") return { label: "Thinking of what to say", live: true };
    if (v.on && v.state === "speaking") return { label: topic ? "Talking about " + topic : "Talking with " + first, live: true };
    if (p.screen.current?.streaming && topic) return { label: "Pulling up " + topic, live: true };
    if (topic) return { label: "Showing " + topic, live: false };
    return { label: v.on ? "With " + first : "Profile ready", live: false };
  }
  if (p.guest) return { label: "Meeting someone new", live: true };
  if (p.looking) return { label: "Recognizing…", live: true };
  return { label: "Watching for faces", live: false };
}

// ---------- which card the voice is on ----------

type Focus = { card: string; item?: string } | null;

const STOP = new Set(
  ("the and for with their his her about from that this into what who was are has have had their them they you your our " +
    "project projects work worked team intern engineer engineering student role roles company university school western hackathon " +
    "inc ltd corp lab club society network program").split(" "),
);
const words = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length >= 3 && !STOP.has(w));

/** The card (and the line in it) that best matches what the voice is showing or saying. */
function focusOf(text: string, p: Profile): Focus {
  const said = new Set((text ?? "").toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean));
  if (!said.size) return null;
  const hits: { card: string; item?: string; tokens: string[] }[] = [];
  p.projects?.forEach((x) => hits.push({ card: "projects", item: x.name, tokens: [...words(x.name), ...words(x.event)] }));
  p.wins?.wins.forEach((w, i) => hits.push({ card: "wins", item: "w" + i, tokens: [...words(w.event), ...words(w.prize.split(/[(,]/)[0]), "won", "win", "winner", "prize"] }));
  p.wins?.awards.forEach((a, i) => hits.push({ card: "wins", item: "a" + i, tokens: [...words(a.split(/[(:,]/)[0]), "award", "scholarship"] }));
  for (const k of ["now", "past", "leading"] as const)
    p.roles?.[k].forEach((r, i) => hits.push({ card: "roles", item: k + i, tokens: [...words(r.org?.name), ...words(r.title).filter((w) => w.length > 4)] }));
  if (p.school) hits.push({ card: "school", tokens: ["ivey", "hba", "aeo", "western", "school", "degree", "program", "studies", "studying", "major", "university", ...words(p.school.program)] });
  p.repos?.forEach((r) => hits.push({ card: "repos", item: r.name, tokens: [...words(r.name), "github", "repo", "code"] }));
  p.meet?.forEach((m) => hits.push({ card: "meet", item: m.id, tokens: [...words(m.name), "meet", "introduce", "connect"] }));
  let best: { card: string; item?: string; score: number } | null = null;
  for (const h of hits) {
    const score = new Set(h.tokens.filter((t) => said.has(t))).size;
    if (score > 0 && (!best || score > best.score)) best = { card: h.card, item: h.item, score };
  }
  return best ? { card: best.card, item: best.item } : null;
}

// ---------- the panel ----------

export function Panel(props: Props) {
  const reduce = !!useReducedMotion();
  const { personId, guest, voice, screen, lines } = props;
  const prof = useProfile(personId);
  const p = prof.profile;
  const id = p.identity;
  const name = id?.name ?? "";
  const shown = screen.current;
  const topic = personId ? topicOf(shown?.request, name) : null;
  const phase = phaseOf(props, prof.streaming, prof.status?.label ?? null, id?.first ?? null, topic);
  const speaking = voice.on && voice.state === "speaking" && voice.caption?.who === "greeter";
  const talkText = personId ? shown?.request ?? (speaking ? voice.caption?.text.slice(-180) ?? "" : "") : "";
  const focus = personId ? focusOf(talkText, p) : null;

  // The trail of what just happened, newest last; it starts over for each new person.
  const who = personId ?? (guest ? "guest" : null);
  const [trail, setTrail] = useState<{ who: string | null; list: Phase[] }>({ who, list: [phase] });
  const tip = trail.list.at(-1);
  if (trail.who !== who || tip?.label !== phase.label || tip?.live !== phase.live) {
    const kept = trail.who === who ? trail.list.filter((x) => x.label !== phase.label && !x.stand) : [];
    setTrail({ who, list: [...kept, phase].slice(-3) });
  }

  const vars = { "--accent": "#a594ff", "--accent-soft": "rgba(165,148,255,0.16)" } as CSSProperties;
  const others = props.members.filter((m) => m.id !== personId);

  return (
    <aside
      style={vars}
      // overflow-clip (not hidden) so the footer below can stick to the bottom of a short, stacked window
      className={cn("relative flex w-full shrink-0 flex-col overflow-clip rounded-[28px] bg-[#111113] ring-1 ring-white/[0.06]", props.className)}
    >
      {/* a quiet wash of colour behind the panel, from the person's own photo */}
      <AnimatePresence>
        {id?.photo && (
          <motion.div key={id.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 1.2 }} className="pointer-events-none absolute inset-x-0 top-0 h-[420px] overflow-hidden">
            <Glow src={id.photo} className="-left-24 -top-32 h-[420px] w-[520px]" opacity={0.22} />
          </motion.div>
        )}
      </AnimatePresence>

      <header className="relative flex items-center justify-between gap-3 px-6 pt-5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-[9px] bg-[linear-gradient(140deg,#b6a8ff,#6b5cff)] text-[13px] font-black tracking-[-0.04em] text-white shadow-[0_6px_18px_-6px_rgba(107,92,255,0.8)]">
            HW
          </span>
          <div className="leading-tight">
            <p className="text-[14px] font-semibold tracking-[-0.01em]">Greeter</p>
            <p className="text-[11.5px] font-medium text-label-3">Hack Western 13</p>
          </div>
        </div>
        <RecruiterChip />
        <span className="flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-[11.5px] font-medium text-label-2">
          <span className="relative grid size-1.5 place-items-center">
            {props.connected && !reduce && <span className="absolute size-1.5 animate-ping rounded-full bg-green opacity-60" />}
            <span className={"size-1.5 rounded-full " + (props.connected ? "bg-green" : "bg-orange")} />
          </span>
          {props.connected ? "Live" : "Reconnecting"}
        </span>
      </header>

      <Trail list={trail.list} reduce={reduce} />

      <div className="no-scrollbar relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 pt-1">
        <AnimatePresence mode="popLayout" initial={false}>
          {personId && id ? (
            <PersonCards key={personId} profile={p} focus={focus} topic={topic} screen={screen} others={others} lines={lines} reduce={reduce} />
          ) : personId && !prof.error ? (
            <Skeleton key="loading" reduce={reduce} />
          ) : guest || personId ? (
            <Guest key="guest" lines={lines} reduce={reduce} />
          ) : (
            <Empty key="empty" looking={props.looking} known={props.known ?? null} reduce={reduce} />
          )}
        </AnimatePresence>
        {prof.error && personId && <p className="px-2 text-[13px] text-label-3">{prof.error}</p>}
      </div>

      {/* Below lg the camera and panel stack and the page scrolls; keep the buttons pinned in view. */}
      <footer className="sticky bottom-0 z-20 rounded-b-[28px] border-t border-white/[0.06] bg-[#111113]/90 p-3 backdrop-blur-xl">{props.footer}</footer>
    </aside>
  );
}

// ---------- status ----------

function Trail({ list, reduce }: { list: Phase[]; reduce: boolean }) {
  return (
    <div
      className="relative px-6 pb-3 pt-4"
      style={{ "--color-background": "#ffffff", "--color-muted-foreground": "rgba(235,235,245,0.5)" } as CSSProperties}
      aria-live="polite"
    >
      <ol className="flex flex-col gap-1">
        <AnimatePresence initial={false} mode="popLayout">
          {list.map((x, i) => {
            const last = i === list.length - 1;
            return (
              <motion.li
                key={x.label}
                layout={!reduce}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: "blur(4px)" }}
                animate={{ opacity: last ? 1 : 0.55, y: 0, filter: "blur(0px)" }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(4px)" }}
                transition={SPRING}
                className={cn("flex min-w-0 items-center gap-2.5", last ? "text-[17px] font-semibold tracking-[-0.01em]" : "text-[13px] font-medium text-label-2")}
              >
                {last ? (
                  <span className="relative grid size-2.5 shrink-0 place-items-center">
                    {x.live && !reduce && <span className="absolute size-2.5 animate-ping rounded-full bg-[var(--accent)] opacity-50" />}
                    <span className={"size-2 rounded-full " + (x.live ? "bg-[var(--accent)]" : "bg-white/40")} />
                  </span>
                ) : (
                  <Check />
                )}
                {last && x.live ? (
                  <Shimmer as="span" duration={2.2} className="truncate">
                    {x.label}
                  </Shimmer>
                ) : (
                  <span className="truncate">{x.label}</span>
                )}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
    </div>
  );
}

// ---------- cards ----------

function Card({
  k,
  focus,
  label,
  aside,
  reduce,
  className,
  children,
}: {
  k: string;
  focus?: Focus;
  label?: string;
  aside?: ReactNode;
  reduce: boolean;
  className?: string;
  children: ReactNode;
}) {
  const on = focus?.card === k;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!on) return;
    // after cards around it have finished coming and going, so the layout shift can't cancel the scroll
    const t = setTimeout(() => ref.current?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }), 240);
    return () => clearTimeout(t);
  }, [on, reduce]);
  return (
    <motion.section
      ref={ref}
      layout={reduce ? false : "position"}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98, filter: "blur(8px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, filter: "blur(6px)", transition: { duration: 0.2 } }}
      transition={SPRING}
      className={cn(
        "relative shrink-0 rounded-[22px] p-5 ring-1 transition-[background-color,box-shadow] duration-500",
        on
          ? "bg-[rgba(165,148,255,0.08)] shadow-[0_0_0_1px_rgba(165,148,255,0.55),0_24px_60px_-24px_rgba(165,148,255,0.55)] ring-transparent"
          : "bg-white/[0.035] ring-white/[0.06]",
        className,
      )}
    >
      {label && (
        <header className="mb-3.5 flex items-center justify-between gap-2">
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.09em] text-label-3">{label}</p>
          <AnimatePresence initial={false} mode="popLayout">
            {on ? (
              <motion.span
                key="on"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="flex items-center gap-1.5 rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--accent)]"
              >
                <Bars reduce={reduce} />
                Talking about this
              </motion.span>
            ) : (
              aside
            )}
          </AnimatePresence>
        </header>
      )}
      {children}
    </motion.section>
  );
}

function PersonCards({
  profile: p,
  focus,
  topic,
  screen,
  others,
  lines,
  reduce,
}: {
  profile: Profile;
  focus: Focus;
  topic: string | null;
  screen: ScreenHandle;
  others: { id: string; name: string }[];
  lines: PanelLine[];
  reduce: boolean;
}) {
  const id = p.identity!;
  const shown = screen.current;
  const roleCount = (p.roles?.now.length ?? 0) + (p.roles?.past.length ?? 0) + (p.roles?.leading.length ?? 0);
  const item = (card: string, key: string) => focus?.card === card && focus.item === key;
  // While the voice has something on screen, that is the card it is on; matching lines elsewhere still light up.
  const lit = shown ? null : focus;
  return (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: -16, filter: "blur(6px)", transition: { duration: 0.2 } }}
      transition={SPRING}
      className="flex flex-col gap-3"
    >
      {/* who they are */}
      <Card k="identity" reduce={reduce} className="overflow-hidden p-0">
        <div className="relative flex items-center gap-4 p-5">
          <span className="relative shrink-0">
            <Face name={id.name} srcs={id.photo ? [id.photo] : []} size={76} />
            <span className="absolute -bottom-0.5 -right-0.5 grid size-5 place-items-center rounded-full bg-green ring-[3px] ring-[#17171a]">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.09em] text-[var(--accent)]">{id.role}</p>
            <h2 className="title mt-0.5 text-[clamp(24px,2.1vw,32px)] font-bold leading-[1.08] tracking-[-0.02em]">{id.name}</h2>
            {id.headline && <p className="mt-1 line-clamp-2 text-[14.5px] leading-snug text-label-2">{id.headline}</p>}
          </div>
          {id.mark?.logo && <Logo org={id.mark} className="h-14 w-[118px] shrink-0 self-start" />}
        </div>
        {others.length > 0 && (
          <div className="flex items-center gap-2 border-t border-white/[0.06] px-5 py-3 text-[13px] text-label-2">
            <span className="flex -space-x-2">
              {others.slice(0, 4).map((m) => (
                <Face key={m.id} name={m.name} srcs={m.id.startsWith("guest-") ? [] : ["/api/greeter/face?id=" + encodeURIComponent(m.id)]} size={24} className="ring-2 ring-[#17171a]" />
              ))}
            </span>
            With {others.map((m) => (m.id.startsWith("guest-") ? "a guest" : m.name.split(/\s+/)[0])).join(", ")}
          </div>
        )}
      </Card>

      {/* what the voice put on screen */}
      <AnimatePresence mode="popLayout" initial={false}>
        {shown && (
          <Card
            key="screen"
            k="screen"
            focus={{ card: "screen" }}
            label="On screen"
            reduce={reduce}
            aside={null}
            className="p-0 [&>header]:mb-0 [&>header]:px-5 [&>header]:pt-4"
          >
            <div className="flex items-start justify-between gap-3 px-5 pb-1 pt-1">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.p
                  key={shown.key}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.12 } }}
                  transition={SPRING}
                  className="title text-[18px] font-semibold leading-snug"
                >
                  {topic ?? shown.request}
                </motion.p>
              </AnimatePresence>
              <button
                type="button"
                onClick={screen.clear}
                aria-label="Put the screen away"
                className="press -mr-1 grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.08] text-label-2 hover:bg-white/15 hover:text-label"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            {/* moments center themselves for the full /talk stage; here, when one runs taller than the card, it
                starts at its title and scrolls instead of spilling out of the top */}
            <div className="no-scrollbar relative h-[clamp(320px,48vh,580px)] overflow-y-auto px-4 pb-4 pt-2 [overflow-anchor:none] [&_.justify-center]:[justify-content:safe_center]">
              {/* one slot per request: a new topic replaces the last one at once, never waits behind it */}
              <AnimatePresence mode="popLayout" initial={false}>
                <Moment key={shown.key} shown={shown} me={{ name: id.name, photo: id.photo }} reduce={reduce} />
              </AnimatePresence>
            </div>
          </Card>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {p.school && (
          <Card key="school" k="school" focus={lit} label="School" reduce={reduce}>
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-[17px] font-semibold leading-snug">{p.school.name}</p>
                {p.school.program && <p className="mt-1 text-[14.5px] leading-snug text-label-2">{p.school.program}</p>}
                {p.school.year && <p className="mt-2 text-[12.5px] font-medium text-label-3">Class of {p.school.year}</p>}
              </div>
              {p.school.logo && <Logo org={{ name: p.school.name, logo: p.school.logo }} className="h-12 w-[112px] shrink-0" />}
            </div>
            {p.school.ivey && (
              <div className="mt-4 flex items-center gap-3 rounded-[14px] bg-[rgba(3,70,56,0.28)] p-2.5 pr-3.5 ring-1 ring-[rgba(80,170,140,0.25)]">
                {p.school.ivey.logo && <Logo org={p.school.ivey} className="h-10 w-[92px] shrink-0 rounded-[9px]" />}
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold">{p.school.ivey.name}</p>
                  <p className="text-[12.5px] text-label-2">Ivey Business School</p>
                </div>
              </div>
            )}
          </Card>
        )}

        {p.roles && roleCount > 0 && (
          <Card key="roles" k="roles" focus={lit} label="Experience" reduce={reduce}>
            <div className="flex flex-col gap-4">
              <Roles title="Now" list={p.roles.now} k="now" hot={(i) => item("roles", "now" + i)} />
              <Roles title="Before" list={p.roles.past} k="past" hot={(i) => item("roles", "past" + i)} />
              <Roles title="Leads" list={p.roles.leading} k="leading" hot={(i) => item("roles", "leading" + i)} />
            </div>
          </Card>
        )}

        {p.projects && p.projects.length > 0 && (
          <Card key="projects" k="projects" focus={lit} label="Projects" reduce={reduce}>
            <ul className="flex flex-col gap-1">
              {p.projects.map((x) => (
                <Row key={x.name} hot={item("projects", x.name)}>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <p className="text-[15.5px] font-semibold">{x.name}</p>
                    {x.event && <Chip>{x.event}</Chip>}
                  </div>
                  {x.about && <p className="mt-0.5 line-clamp-2 text-[13.5px] leading-snug text-label-2">{x.about}</p>}
                </Row>
              ))}
            </ul>
          </Card>
        )}

        {p.wins && (p.wins.wins.length > 0 || p.wins.awards.length > 0) && (
          <Card key="wins" k="wins" focus={lit} label="Wins and awards" reduce={reduce}>
            <ul className="flex flex-col gap-1">
              {p.wins.wins.map((w, i) => (
                <Row key={"w" + i} hot={item("wins", "w" + i)} icon={<Trophy />}>
                  <p className="text-[14.5px] font-semibold leading-snug">{w.prize}</p>
                  {w.event && <p className="mt-0.5 text-[13px] text-label-2">{w.event}</p>}
                </Row>
              ))}
              {p.wins.awards.map((a, i) => (
                <Row key={"a" + i} hot={item("wins", "a" + i)} icon={<Medal />}>
                  <p className="text-[13.5px] leading-snug text-label">{a}</p>
                </Row>
              ))}
            </ul>
          </Card>
        )}

        {p.points && p.points.length > 0 && (
          <Card key="points" k="points" focus={lit} label="Talking points" reduce={reduce}>
            <ul className="flex flex-col gap-2.5">
              {p.points.map((x) => (
                <li key={x} className="flex gap-3 text-[14px] leading-snug text-label-2">
                  <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                  <span className="line-clamp-3">{x}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {p.repos && p.repos.length > 0 && (
          <Card key="repos" k="repos" focus={lit} label="On GitHub" reduce={reduce}>
            <ul className="flex flex-col gap-1">
              {p.repos.map((r) => (
                <Row key={r.url} hot={item("repos", r.name)}>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-[15px] font-semibold">
                      <span className="text-label-3">{r.owner}/</span>
                      {r.name}
                    </p>
                    <span className="shrink-0 text-[12.5px] text-label-2">★ {r.stars.toLocaleString()}</span>
                  </div>
                  {r.description && <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-label-2">{r.description}</p>}
                  {r.language && <p className="mt-1 text-[12px] text-label-3">{r.language}</p>}
                </Row>
              ))}
            </ul>
          </Card>
        )}

        {p.meet && p.meet.length > 0 && (
          <Card key="meet" k="meet" focus={lit} label="Should meet" reduce={reduce}>
            <ul className="flex flex-col gap-1">
              {p.meet.map((m) => (
                <Row key={m.id} hot={item("meet", m.id)}>
                  <div className="flex items-center gap-3">
                    <Face name={m.name} srcs={m.photo ? [m.photo] : []} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold">{m.name}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {sharedOf(m.shared).map((s) => (
                          <Chip key={s}>{s}</Chip>
                        ))}
                      </div>
                    </div>
                  </div>
                </Row>
              ))}
            </ul>
          </Card>
        )}

        {lines.length > 0 && (
          <Card key="talk" k="talk" label="Conversation" reduce={reduce}>
            <Transcript lines={lines} />
          </Card>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

const MONTH = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\.?$/i;
/** What two people share, minus the noise (month names, repeats). */
function sharedOf(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = s.toLowerCase();
    if (MONTH.test(s) || s.length < 3 || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 3);
}

function Roles({ title, list, hot }: { title: string; list: RoleItem[]; k: string; hot: (i: number) => boolean }) {
  if (!list.length) return null;
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-semibold text-label-3">{title}</p>
      <ul className="flex flex-col gap-1">
        {list.map((r, i) => (
          <Row key={i} hot={hot(i)} icon={<Logo org={r.org} fallback={r.org?.name ?? r.title} className="h-10 w-[58px] rounded-[10px]" />}>
            <p className="text-[14.5px] font-semibold leading-snug">{r.title || r.org?.name}</p>
            <p className="text-[13px] leading-snug text-label-2">
              {[r.title ? r.org?.name : null, r.when].filter(Boolean).join(" · ")}
            </p>
            {r.detail && <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-label-3">{r.detail}</p>}
          </Row>
        ))}
      </ul>
    </div>
  );
}

function Row({ hot, icon, children }: { hot?: boolean; icon?: ReactNode; children: ReactNode }) {
  return (
    <li
      className={cn(
        "relative -mx-2 flex items-start gap-3 rounded-[14px] px-2 py-2 transition-colors duration-500",
        hot && "bg-[var(--accent-soft)] before:absolute before:inset-y-2.5 before:-left-0.5 before:w-[3px] before:rounded-full before:bg-[var(--accent)]",
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-white/[0.07] px-2 py-0.5 text-[11.5px] font-medium text-label-2">{children}</span>;
}

/** A logo on a white tile (logos are made for white), or the org's first letter when there's no clean logo. */
function Logo({ org, fallback, className }: { org: Org | null | undefined; fallback?: string; className?: string }) {
  if (!org?.logo) {
    if (!fallback) return null;
    return (
      <span className={cn("grid place-items-center rounded-[12px] bg-white/[0.06] text-[15px] font-semibold text-label-2 ring-1 ring-white/[0.06]", className)}>
        {fallback.trim()[0]?.toUpperCase()}
      </span>
    );
  }
  return (
    <span title={org.name} className={cn("grid place-items-center rounded-[12px] bg-white px-2 py-1.5 shadow-[0_8px_24px_-10px_rgba(0,0,0,0.7)]", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={org.logo} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
    </span>
  );
}

function Transcript({ lines }: { lines: PanelLine[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {lines.slice(-4).map((l) => (
        <li key={l.key} className={cn("text-[13.5px] leading-snug", l.who === "greeter" ? "text-label" : "text-label-2")}>
          <span className="mr-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-label-3">{l.who === "greeter" ? "Greeter" : "Them"}</span>
          {l.text}
        </li>
      ))}
    </ul>
  );
}

/** "Parum Patel's hardware wiring project" -> "Parum Patel"; the person a request is about, when it names one. */
const aboutOf = (request: string) => request.match(/^\s*([A-Z][\w.-]*(?:\s+[A-Z][\w.-]*){0,2})['’]s?\s/)?.[1] ?? null;
/** "Parum Patel's hardware wiring project" -> "Hardware wiring project": the thing itself, for the draft's title. */
const thingOf = (request: string) => {
  const t = request.replace(/^\s*[A-Z][\w.-]*(?:\s+[A-Z][\w.-]*){0,2}['’]s?\s+/, "").replace(/[.!]+$/, "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : request;
};
/** The model has started its first real component (beyond the root line), so there is something to draw. */
const drawable = (text: string) => /\n\s*\w+\s*=\s*[A-Z]\w*\(\s*["[{]/.test(text);

/**
 * One request on screen. It opens at once with a draft made from what the panel already knows (the topic set
 * large, the face of who it is about), and the generated moment takes over as soon as its first component lands.
 */
function Moment({ shown, me, reduce, ...rest }: { shown: Shown; me: { name: string; photo: string | null }; reduce: boolean }) {
  const text = settled(shown.text, shown.streaming);
  const ready = drawable(text);
  const named = aboutOf(shown.request);
  const isMe = !named || me.name.toLowerCase().startsWith(named.toLowerCase().split(/\s+/)[0]);
  const thing = thingOf(shown.request);
  return (
    <motion.div
      {...rest}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduce ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, y: -10, filter: "blur(8px)", transition: { duration: 0.16 } }}
      transition={{ duration: 0.18 }}
      className="relative h-full"
    >
      <AnimatePresence>
        {!ready && !shown.error && (
          <motion.div
            key="draft"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            className="absolute inset-0 flex flex-col justify-center gap-5 px-1"
            aria-live="polite"
          >
            <span aria-hidden className="pointer-events-none absolute -left-6 top-6 size-[220px] rounded-full bg-[rgba(165,148,255,0.18)] blur-[70px] motion-safe:animate-pulse" />
            <div className="flex items-center gap-3">
              {isMe ? (
                <Face name={me.name} srcs={me.photo ? [me.photo] : []} size={44} />
              ) : (
                <PersonFace name={named} size={44} />
              )}
              <Shimmer as="span" duration={1.6} className="text-[14px] font-medium">
                {isMe ? "Putting it on screen" : "Pulling up " + (named ?? "it")}
              </Shimmer>
            </div>
            <h3 className="title text-balance text-[clamp(30px,2.6vw,46px)] font-bold leading-[1.04] tracking-[-0.03em] text-white">
              {thing.split(/\s+/).map((word, i) => (
                <motion.span
                  key={word + i}
                  className="inline-block whitespace-pre"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: "blur(6px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  transition={reduce ? { duration: 0.15 } : { type: "spring", bounce: 0, duration: 0.5, delay: i * 0.05 }}
                >
                  {word + " "}
                </motion.span>
              ))}
            </h3>
            <div className="flex flex-col gap-2" aria-hidden>
              {[0.9, 0.72, 0.8].map((wd, i) => (
                <motion.span
                  key={i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.15 + i * 0.08, duration: 0.3 }}
                  className="h-11 rounded-[14px] bg-white/[0.04] motion-safe:animate-pulse"
                  style={{ width: wd * 100 + "%" }}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <motion.div className="h-full" initial={false} animate={{ opacity: ready || shown.error ? 1 : 0 }} transition={{ duration: 0.25 }}>
        <GenCanvas response={text} streaming={shown.streaming} />
      </motion.div>
      {shown.error && <p className="mt-3 text-[13px] text-label-3">Couldn&apos;t build that screen.</p>}
    </motion.div>
  );
}

// ---------- other states ----------

function Empty({ looking, known, reduce }: { looking: boolean; known: number | null; reduce: boolean }) {
  const steps = [
    ["Recognize", known ? `Knows ${known} Hack Western hackers by face` : "Knows the Hack Western hackers by face"],
    ["Pull their profile", "School, roles, projects and wins, streamed in"],
    ["Talk", "Says hi and shows what it's talking about"],
  ];
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ duration: 0.4 }}
      className="flex min-h-full flex-1 flex-col items-center justify-center gap-8 px-4 py-10 text-center"
    >
      <div className="relative grid size-[132px] place-items-center">
        {!reduce &&
          [0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="absolute inset-0 rounded-full ring-1 ring-[rgba(165,148,255,0.45)]"
              initial={{ scale: 0.55, opacity: 0 }}
              animate={{ scale: [0.55, 1.15], opacity: [0, 0.8, 0] }}
              transition={{ duration: looking ? 1.6 : 3.2, repeat: Infinity, delay: i * (looking ? 0.53 : 1.07), ease: "easeOut" }}
            />
          ))}
        <span className="grid size-[76px] place-items-center rounded-full bg-[radial-gradient(circle_at_30%_25%,rgba(190,178,255,0.35),rgba(107,92,255,0.12)_60%,transparent)] ring-1 ring-white/10">
          <FaceGlyph />
        </span>
      </div>
      <div>
        <p className="title text-[26px] font-bold tracking-[-0.02em]">{looking ? "Recognizing…" : "Step up to the camera"}</p>
        <p className="mx-auto mt-2 max-w-[330px] text-[15px] leading-relaxed text-label-2">
          {looking ? "Hold still for a second while the greeter places your face." : "The greeter will recognize you, pull up who you are and say hi."}
        </p>
      </div>
      <ol className="w-full max-w-[360px] space-y-2 text-left">
        {steps.map(([t, d], i) => (
          <li key={t} className="flex items-center gap-3 rounded-[16px] bg-white/[0.035] px-4 py-3 ring-1 ring-white/[0.05]">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--accent-soft)] text-[12.5px] font-bold text-[var(--accent)]">{i + 1}</span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold">{t}</span>
              <span className="block text-[12.5px] text-label-3">{d}</span>
            </span>
          </li>
        ))}
      </ol>
    </motion.div>
  );
}

function Guest({ lines, reduce }: { lines: PanelLine[]; reduce: boolean }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col gap-3">
      <Card k="guest" reduce={reduce}>
        <div className="flex items-center gap-4">
          <span className="grid size-[64px] place-items-center rounded-full bg-white/[0.06] ring-1 ring-white/10">
            <FaceGlyph />
          </span>
          <div>
            <p className="title text-[22px] font-bold">Someone new</p>
            <p className="mt-0.5 text-[14px] text-label-2">Not on the Hack Western list yet. Teach their face below to remember them.</p>
          </div>
        </div>
      </Card>
      {lines.length > 0 && (
        <Card k="talk" label="Conversation" reduce={reduce}>
          <Transcript lines={lines} />
        </Card>
      )}
    </motion.div>
  );
}

function Skeleton({ reduce }: { reduce: boolean }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} className="flex flex-col gap-3">
      {[120, 150, 190].map((h, i) => (
        <div key={i} style={{ height: h }} className={cn("rounded-[22px] bg-white/[0.035] ring-1 ring-white/[0.05]", !reduce && "animate-pulse")} />
      ))}
    </motion.div>
  );
}

// ---------- icons ----------

function Check() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" className="ml-px shrink-0" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function Bars({ reduce }: { reduce: boolean }) {
  return (
    <span className="flex h-2.5 items-end gap-[2px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-[2.5px] rounded-full bg-current"
          initial={{ height: 4 }}
          animate={reduce ? { height: 6 } : { height: [3, 10, 5, 9, 3] }}
          transition={{ duration: 1, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
        />
      ))}
    </span>
  );
}

function Trophy() {
  return (
    <span className="grid size-9 place-items-center rounded-[11px] bg-[rgba(255,196,0,0.12)] text-[#ffcc3d]">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />
      </svg>
    </span>
  );
}

function Medal() {
  return (
    <span className="grid size-9 place-items-center rounded-[11px] bg-white/[0.06] text-label-2">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="14" r="6" />
        <path d="M8.5 9.5L6 3h4l2 4 2-4h4l-2.5 6.5" />
      </svg>
    </span>
  );
}

function FaceGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="rgba(235,235,245,0.8)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M9 10h.01M15 10h.01M9.5 15a3.5 3.5 0 0 0 5 0" />
    </svg>
  );
}

