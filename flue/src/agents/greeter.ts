'use agent';
// The Greeter's decision maker: the real version of greeter/greeter/agent.py's MockAgent.
// One conversation per person (initialData { id }); each time the camera sees them it decides, through
// the typed decide tool, whether to greet them, check their name first, or stay quiet, and what to say.
// Serve it to the camera with: npm run brain   (src/brain.ts)
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { defineTool, setProvider, useDataWriter, useDelivery, useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { Decision, MAX_POINTS, problemWith, QUIET_MINUTES, Seen, spokenName } from '../decision.ts';
import { findPeople } from '../tools/people.ts';

// With GEMINI_API_KEY set, Flue talks to Google's Gemini API directly (pi-ai's built-in google provider) and
// Gemini makes every greet/confirm/skip decision and holds every conversation. Without it, ANTHROPIC_API_KEY
// talks to Anthropic directly; GREETER_MODEL=openai/gpt-4.1-mini uses OPENAI_API_KEY. Otherwise models go
// through a local OpenAI-compatible server (OpenCodex on Prag's Mac); point OCX_BASE_URL elsewhere if needed.
// GREETER_MODEL always wins.
const OCX = process.env.OCX_BASE_URL ?? 'http://localhost:10100/v1';
const CLAUDE = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-5-5'];
setProvider(
	createProvider({
		id: 'ocx',
		// OpenCodex ignores the key, but pi-ai's OpenAI client refuses to send a request without one.
		auth: { apiKey: { name: 'OpenCodex (keyless)', resolve: async () => ({ auth: { apiKey: process.env.OCX_API_KEY ?? 'unused' } }) } },
		models: CLAUDE.map((m) => ({
			id: `anthropic/${m}`,
			name: `${m} via OpenCodex`,
			api: 'openai-completions',
			provider: 'ocx',
			baseUrl: OCX,
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		})),
		api: openAICompletionsApi(),
	}),
);

/** Gemini 3 Flash: answers in about a second, fast enough for someone walking past the table. */
export const GEMINI_MODEL = 'google/gemini-3-flash-preview';

export const MODEL =
	process.env.GREETER_MODEL ??
	(process.env.GEMINI_API_KEY
		? GEMINI_MODEL
		: process.env.ANTHROPIC_API_KEY
			? 'anthropic/claude-haiku-4-5'
			: 'ocx/anthropic/claude-haiku-4-5');

/**
 * Each conversation belongs to one person, fixed when it is created: the agent can't wander off to someone else.
 * name is what the camera calls them, used when this machine's greeter.db doesn't have them.
 */
const Who = v.object({ id: v.pipe(v.string(), v.minLength(1)), name: v.optional(v.string(), '') });

export function Greeter() {
	// No extended thinking: a greeting that arrives after the person has walked off is useless.
	useModel(MODEL, { thinkingLevel: 'off' });
	const who = useInitialData<v.InferOutput<typeof Who>>();
	const person = findPeople(who.id).find((p) => p.id === who.id); // exact id only, never a partial name match
	const name = person?.name || who.name || who.id;
	const callThem = spokenName(name);
	const points = (person?.talkingPoints ?? []).slice(0, MAX_POINTS);
	const seen = lastSighting();
	// The decision lands on the reply as typed data (reply.data.decision); the model never sees it echoed.
	const record = useDataWriter('decision', { schema: Decision });
	useTool(
		defineTool({
			name: 'decide',
			description: 'Record what the greeter does about this person. Call it exactly once, as your last step.',
			input: Decision,
			async run({ data }) {
				const problem = problemWith(data, points.length, name, seen);
				// Throwing hands the problem back to the model, which fixes the call and tries again.
				if (problem) throw new Error(problem);
				record(data);
				return { output: 'recorded', terminate: true };
			},
		}),
	);
	const profile = [
		`Name: ${name}`,
		callThem ? `Call them: ${callThem}` : 'Call them: no name (their name looks like a username, so never say it; just say hi)',
		person?.role ? `Slack role: ${person.role}` : '',
		points.length ? 'Talking points (by index):\n' + points.map((p, i) => `  ${i}. ${p}`).join('\n') : 'Talking points: none yet',
	]
		.filter(Boolean)
		.join('\n');
	return `You are the brain of a greeter robot at Prag's table at Hack Western 13, a student hackathon at
Western University. You only ever talk to this one person:

${profile}

Each time the camera sees them you get a camera.sighting signal with JSON: { score, bar, visit, others,
minutesSinceLast }. score is how sure the face match is (the camera only names a face at or above bar),
visit is 1 the first time you see them (so never say welcome back then) and counts up on later visits,
others are other people in view, and minutesSinceLast is how long ago you last spoke to them (null if never).

Call decide exactly once and stop:
- greet when the match is solid. One or two short spoken sentences: greet them by the name under Call them, then
  bring up ONE talking point in the second person ("You won X. How did ...?") and set fact to its index.
- confirm when score is within about 0.05 of bar: check their name first (${callThem ? `"Hi, are you ${callThem}?"` : '"Hi there, have we met?"'})
  and bring up no facts yet (fact null).
- skip only when minutesSinceLast is under ${QUIET_MINUTES} and another line would be repetitive. Otherwise, on a
  return visit, give a short welcome back with a talking point you haven't used yet.
- With no talking points, greet them warmly and ask what they are building this weekend.
Never invent facts: everything you say about them comes from the talking points above. Talk to them,
not to the others in view.

say is read aloud, so write only the spoken words: no narration, lists, markdown, emoji or quotation
marks. Don't write any text outside the tool call.`;
}
Greeter.initialData = Who;

/** The sighting in front of the model right now, read from the message itself so no tool trusts the model to echo it. */
function lastSighting(): Seen | null {
	const delivery = useDelivery();
	if (delivery.kind !== 'signal' || delivery.type !== 'camera.sighting') return null;
	try {
		const parsed = v.safeParse(Seen, JSON.parse(delivery.body));
		return parsed.success ? parsed.output : null;
	} catch {
		return null;
	}
}
