// What the model may write: every component's name, props and description, with no React in it, so the
// server route can build the system prompt (react-lang creates React contexts at import, which the server
// layer can't load). library.tsx attaches the renderers to these same definitions.
//
// The set is moments, not cards: each carries one idea visually (a face, a live number, a drawn line, a
// quote), with text only as a glance. A screen is one moment, sometimes with a mark or two beside it.
import { createLibrary, defineComponent, tagSchemaId, type ComponentGroup } from "@openuidev/lang-core";
import { z } from "zod/v4";

const def = <T extends z.ZodObject>(name: string, description: string, props: T) =>
  defineComponent({ name, description, props, component: null });

const url = z.string();

// ─── Moments ────────────────────────────────────────────────────────────────

export const Portrait = def(
  "Portrait",
  "The person, large: their photo coming into focus, their name the only text. For \"this is who you're talking to\". photo is the Person's photo; images their Person.images (copy both as given).",
  z.object({
    name: z.string(),
    photo: url.nullable().optional(),
    images: z.array(url).optional(),
  }),
);

export const ProjectMoment = def(
  "ProjectMoment",
  "One thing they built. With a GitHub URL (a repo, or a user or org, which shows their most-starred repo) it shows live stars counting up, its language and a year of commits, fetched by itself: never write numbers for it. url from Person.pages (kind github or repo) or the request. line overrides the one-line description (under 12 words); image a picture for a project not on GitHub.",
  z.object({
    url: url,
    name: z.string().optional(),
    line: z.string().optional(),
    image: url.nullable().optional(),
  }),
);

const who = z.object({
  name: z.string(),
  word: z.string(),
  photo: url.nullable().optional(),
  where: z.string().optional(),
});

const mark = z.enum(["win", "school", "work", "code", "place", "writing", "talk", "skill"]);

export const Spotlight = def(
  "Spotlight",
  "One thing they did that has no repo or picture of its own: a project, a role, an event they ran, a club, a prize. title is the thing in 2 to 5 words (\"Hardware wiring rig\", \"ChatGPT Lab at Western\"); line one sentence under 14 words about what it is or why it matters; beats 2 or 3 short facts (at most 5 words each) with a mark; person the name of who it is about (their face is found by name), photo their Person.photo; kicker 1 to 3 words above the title (\"Built at Ivey\", \"Autodesk intern\"); org the company, school or club behind it, written as its name (its logo appears when we have one); image a page photo when there is one.",
  z.object({
    title: z.string(),
    line: z.string().optional(),
    beats: z.array(z.object({ text: z.string(), mark: mark.optional() })).optional(),
    person: z.string().optional(),
    photo: url.nullable().optional(),
    kicker: z.string().optional(),
    org: z.string().optional(),
    image: url.nullable().optional(),
  }),
);

export const Faces = def(
  "Faces",
  "2 to 5 people this person should meet, best first, each on a curved line from them. word is the ONE word (two at most) they share, written on the line: \"Groq\", \"TinyTPU\", \"Ivey\", \"chips\". where is optional, e.g. a table number. name and photo are the person in the middle.",
  z.object({
    name: z.string(),
    people: z.array(who),
    photo: url.nullable().optional(),
  }),
);

const step = z.object({
  when: z.string().optional(),
  what: z.string(),
  now: z.boolean().optional(),
});

export const Path = def(
  "Path",
  "How they got here: 2 to 6 steps, oldest first, drawn as one rising line with a mark each. when is a year or short date, what at most 4 words (\"Groq\", \"Built TinyTPU\", \"NVIDIA\"). now: true on the step they are at (default the last).",
  z.object({ steps: z.array(step) }),
);

export const QuoteMoment = def(
  "QuoteMoment",
  "One line they wrote or said, set large, word for word from a fact or page (shorten with an ellipsis, never reword). source is the page URL, site its short name (\"Substack\").",
  z.object({
    text: z.string(),
    source: url.nullable().optional(),
    site: z.string().optional(),
  }),
);

export const BigNumber = def(
  "BigNumber",
  'One number that tells the story, counting up, with a label of at most 3 words: BigNumber("1.4k", "GitHub stars"). value exactly as the data says it; source the page it came from.',
  z.object({
    value: z.union([z.string(), z.number()]),
    label: z.string(),
    source: url.nullable().optional(),
  }),
);

const member = z.object({
  name: z.string(),
  group: z.string().optional(),
  photo: url.nullable().optional(),
});

export const Constellation = def(
  "Constellation",
  "Many people at once (search results, everyone who shares something) as small faces gathered into groups. group is one word each (\"Waterloo\", \"Groq\"); highlight the names to light and label (1 to 3).",
  z.object({
    people: z.array(member),
    highlight: z.array(z.string()).optional(),
  }),
);

// ─── Primitives ─────────────────────────────────────────────────────────────

export const Image = def(
  "Image",
  'One picture from a URL in the data (Person.images, a page photo). shape "wide" (16:9, default), "square" or "tall"; caption a few words.',
  z.object({
    src: url,
    alt: z.string().optional(),
    caption: z.string().optional(),
    shape: z.enum(["wide", "square", "tall"]).optional(),
  }),
);

export const Text = def(
  "Text",
  'A glance, never a paragraph: at most 12 words. size "title" for a few large words, "body" (default) for one line, "note" for a small aside. **bold** and [link](url) only.',
  z.object({
    text: z.string(),
    size: z.enum(["title", "body", "note"]).optional(),
  }),
);

const badge = z.object({
  label: z.string(),
  mark: mark.optional(),
});

export const Badges = def(
  "Badges",
  "1 to 5 small marks, each a drawn icon and two or three words: a prize (win), a school, a company (work), a language (code). Beside a moment, never instead of one.",
  z.object({ items: z.array(badge) }),
);

const moments = [Portrait, ProjectMoment, Spotlight, Faces, Path, QuoteMoment, BigNumber, Constellation];
const parts = [Image, Text, Badges];

/** Any component but the layouts. */
const block = z.union([...moments, ...parts].map((c) => c.ref) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
tagSchemaId(block, "Block");

export const Grid = def(
  "Grid",
  "Two or three Blocks side by side (one column on a narrow screen): a QuoteMoment beside a Portrait, two ProjectMoments. columns 2 (default) or 3.",
  z.object({
    children: z.array(block),
    columns: z.union([z.literal(2), z.literal(3)]).optional(),
  }),
);

export const Stack = def(
  "Stack",
  "The screen: 1 to 3 children, top to bottom. Every program's root is one Stack.",
  z.object({
    children: z.array(z.union([Grid.ref, block])),
  }),
);

export const components = [Stack, Grid, ...moments, ...parts];

export const componentGroups: ComponentGroup[] = [
  {
    name: "Moments",
    components: moments.map((c) => c.name),
    notes: ["A screen is ONE of these, matched to what the voice is saying right now."],
  },
  {
    name: "Primitives",
    components: ["Stack", "Grid", ...parts.map((c) => c.name)],
    notes: ["Block means any Moment, Image, Text or Badges."],
  },
];

export const ROOT = "Stack";

/** The same library with no renderers: enough to write the prompt on the server. */
export const spec = createLibrary({ components, componentGroups, root: ROOT });
