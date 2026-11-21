// The contract between the Python greeter and the AI that decides what to do about a person.
// Every value crossing the boundary is checked against one of these schemas, so the camera loop
// never acts on free text: the model can only pick an action, a line and a talking point by index.
import * as v from 'valibot';

/** What the camera saw: sent by greeter/greeter/brain.py when someone has been in view a moment. */
export const Sighting = v.object({
	id: v.pipe(v.string(), v.trim(), v.minLength(1)),
	name: v.pipe(v.string(), v.trim()),
	/** Cosine similarity of the face to their photos; the camera only names a face at or above `bar`. */
	score: v.pipe(v.number(), v.minValue(-1), v.maxValue(1)),
	bar: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.45),
	/** How many times the greeter has greeted this person since it started (1 = first time). */
	visit: v.pipe(v.number(), v.integer(), v.minValue(1)),
	/** Names of the other people in view right now. */
	others: v.optional(v.array(v.string()), []),
});
export type Sighting = v.InferOutput<typeof Sighting>;

/** What the agent is told each time the camera sees its person (sent as a camera.sighting signal). */
export const Seen = v.object({
	score: v.number(),
	bar: v.number(),
	visit: v.number(),
	others: v.array(v.string()),
	/** Minutes since the greeter last spoke to them, or null if it never has. */
	minutesSinceLast: v.nullable(v.number()),
});
export type Seen = v.InferOutput<typeof Seen>;

/** A match this close to the bar might be someone else, so the greeter checks their name first. */
export const SHAKY = 0.05;
export const isShaky = (seen: Pick<Seen, 'score' | 'bar'>) => seen.score < seen.bar + SHAKY;

export const ACTIONS = ['greet', 'confirm', 'skip'] as const;
export type Action = (typeof ACTIONS)[number];

/** The model's decision. It is the input of the agent's decide tool, so Flue rejects a call that doesn't match. */
export const Decision = v.object({
	action: v.pipe(
		v.picklist(ACTIONS),
		v.description('greet: you are sure who it is. confirm: the match is shaky, so check their name first. skip: say nothing (for example you greeted them moments ago).'),
	),
	say: v.pipe(v.string(), v.trim(), v.maxLength(300), v.description('The exact words read aloud to them. Empty only when action is skip.')),
	fact: v.pipe(
		v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
		v.description('Index into talkingPoints of the one fact your line uses, or null when the line uses none.'),
	),
	why: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300), v.description('One short reason, shown to the people running the table.')),
});
export type Decision = v.InferOutput<typeof Decision>;

/** What the brain answers the Python greeter: the decision, where it came from, and the Arduino line to send. */
export type Verdict = Decision & {
	source: 'agent' | 'fallback';
	/** The line for the Arduino, or null to send nothing. Derived in code from the action, never written by the model. */
	link: string | null;
	ms: number;
	error?: string;
};

/** Minutes within which the greeter stays quiet rather than greet the same person again. */
export const QUIET_MINUTES = 2;

/** The agent works from the first this many talking points, the same ones the camera page shows. */
export const MAX_POINTS = 8;

/**
 * The name to say out loud: the first word of their name when it reads as a name. Slack usernames
 * such as "aelrafi3" give null, and the greeter then talks to them without a name.
 */
export function spokenName(name: string): string | null {
	const first = name.trim().split(/\s+/)[0] ?? '';
	return /^\p{L}[\p{L}'’-]*$/u.test(first) ? first : null;
}

/** Cross-field rules a schema can't express on a tool's top-level object. Returns a problem, or null. */
export function problemWith(d: Decision, talkingPoints: number, name: string, seen: Seen | null): string | null {
	if (d.action !== 'skip' && !d.say) return 'say is required unless action is skip';
	if (d.action === 'skip' && (seen?.minutesSinceLast == null || seen.minutesSinceLast >= QUIET_MINUTES))
		return `skip only when you spoke to them under ${QUIET_MINUTES} minutes ago; greet them instead`;
	if (seen && isShaky(seen) && d.action === 'greet')
		return `the match is shaky (score ${seen.score} is within ${SHAKY} of the bar ${seen.bar}), so use confirm`;
	if (d.action === 'confirm' && d.fact !== null) return 'confirm brings up no facts yet, so fact must be null';
	const first = spokenName(name);
	if (d.action !== 'skip' && first && !d.say.toLowerCase().includes(first.toLowerCase()))
		return `say must address them by first name (${first})`;
	if (d.action === 'skip' && d.say) return 'leave say empty when action is skip';
	if (d.fact !== null && d.fact >= talkingPoints)
		return talkingPoints ? `fact must be null or an index from 0 to ${talkingPoints - 1}` : 'this person has no talking points, so fact must be null';
	return null;
}

export function arduinoLine(action: Action, name: string): string | null {
	if (action === 'skip') return null;
	// Only letters, digits, spaces and name punctuation reach the serial line.
	const safe = name.replace(/[^\p{L}\p{N} .'-]/gu, '').trim();
	return `P ${safe || '?'}`;
}

/** Used when the model is unreachable, too slow, or never decides: a safe greeting with no facts. */
export function fallback(s: Sighting, error: string, ms: number): Verdict {
	const first = spokenName(s.name);
	const unsure = isShaky(s);
	const d: Decision = unsure
		? { action: 'confirm', say: first ? `Hi, are you ${first}? What are you building this weekend?` : 'Hi there, have we met? What are you building this weekend?', fact: null, why: 'fallback: the match is close to the bar' }
		: { action: 'greet', say: `Hey ${first ?? 'there'}, good to see you! What are you building this weekend?`, fact: null, why: 'fallback greeting' };
	return { ...d, source: 'fallback', link: arduinoLine(d.action, s.name), ms, error };
}
