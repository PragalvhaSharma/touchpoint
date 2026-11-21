// The brain: a small HTTP server the Python greeter asks what to do when it recognises someone.
// POST /decide with a Sighting (see decision.ts) and get back a Verdict: greet, confirm or skip,
// the line to say, the talking point it used, and the Arduino line. Bad input gets a 400 with the
// schema problems; a slow or failed model gets a safe fallback greeting.
//
//   npm run brain                                   # http://127.0.0.1:8090
//   npm run brain -- --once '{"id":"U0...","name":"Alex Li","score":0.62,"visit":1}'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import * as v from 'valibot';
import { Greeter, MODEL } from './agents/greeter.ts';
import { arduinoLine, Decision, fallback, type Seen, Sighting, type Verdict } from './decision.ts';

const PORT = Number(process.env.GREETER_BRAIN_PORT ?? 8090);
const HOST = process.env.GREETER_BRAIN_HOST ?? '127.0.0.1';
const TIMEOUT_MS = Number(process.env.GREETER_BRAIN_TIMEOUT_MS ?? 5000);
/** After the model fails, answer with the fallback straight away for this long instead of waiting out the timeout per person. */
const COOL_OFF_MS = 30_000;
const DATA = fileURLToPath(new URL('../.data/', import.meta.url));
const once = process.argv.indexOf('--once');
// person id -> when the greeter last said something to them. The server keeps it next to the stored
// conversations, so after a restart the agent still knows how long ago it spoke.
const SPOKE_FILE = DATA + 'last-spoke.json';
const lastSpoke = new Map<string, number>(once < 0 ? readSpoke() : []);
let modelDownUntil = 0;
const queue = new Map<string, Promise<unknown>>(); // person id -> their decision in progress

function readSpoke(): [string, number][] {
	try {
		return Object.entries(JSON.parse(readFileSync(SPOKE_FILE, 'utf8')) as Record<string, number>);
	} catch {
		return [];
	}
}

/** Plain ids (Slack ids like U0CGDSG30DS) keep their readable key; anything else is hex encoded, so two people never share a conversation. */
const conversationId = (id: string) => (/^[\w-]+$/.test(id) ? `person-${id}` : `personhex-${Buffer.from(id).toString('hex')}`);

/** A spoken fallback counts as speaking too, so the two minute quiet rule still holds after a model hiccup. */
function spoke(sighting: Sighting, verdict: Verdict): Verdict {
	if (verdict.action === 'skip') return verdict;
	lastSpoke.set(sighting.id, Date.now());
	if (once < 0) writeFileSync(SPOKE_FILE, JSON.stringify(Object.fromEntries(lastSpoke)));
	return verdict;
}

/** One decision per person at a time, so two quick sightings can't both read the same answer. */
export function decide(sighting: Sighting): Promise<Verdict> {
	const next = (queue.get(sighting.id) ?? Promise.resolve()).then(() => decideNow(sighting));
	const settled = next.catch(() => {});
	queue.set(sighting.id, settled);
	void settled.then(() => queue.get(sighting.id) === settled && queue.delete(sighting.id));
	return next;
}

async function decideNow(sighting: Sighting): Promise<Verdict> {
	const t0 = Date.now();
	if (Date.now() < modelDownUntil) return spoke(sighting, fallback(sighting, 'the model failed moments ago; not waiting on it', 0));
	// One conversation per person, so on a return visit the agent knows what it already said.
	const handle = init(Greeter, { id: conversationId(sighting.id) });
	try {
		const { score, bar, visit, others } = sighting;
		const last = lastSpoke.get(sighting.id);
		const seen: Seen = { score, bar, visit, others, minutesSinceLast: last === undefined ? null : Math.round((t0 - last) / 6000) / 10 };
		const receipt = await handle.dispatch({
			message: { kind: 'signal', type: 'camera.sighting', body: JSON.stringify(seen) },
			initialData: { id: sighting.id, name: sighting.name },
		});
		const reply = await handle.read(receipt, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		const written = reply.data.decision?.at(-1);
		const parsed = v.safeParse(Decision, written);
		if (!parsed.success) return spoke(sighting, fallback(sighting, written === undefined ? 'the agent never called decide' : 'decision failed the schema', Date.now() - t0));
		const d = parsed.output;
		return spoke(sighting, { ...d, source: 'agent', link: arduinoLine(d.action, sighting.name), ms: Date.now() - t0 });
	} catch (err) {
		const timedOut = err instanceof Error && err.name === 'TimeoutError';
		if (timedOut) await handle.abort().catch(() => {}); // don't let a stuck turn block this person's next visit
		modelDownUntil = Date.now() + COOL_OFF_MS;
		return spoke(sighting, fallback(sighting, timedOut ? `no decision within ${TIMEOUT_MS} ms` : String(err instanceof Error ? err.message : err), Date.now() - t0));
	}
}

function serve() {
	// Log and keep serving: a crash here would silently drop the camera back to the mock agent.
	process.on('unhandledRejection', (err) => console.error('unhandled:', err));
	const server = createServer((req, res) => {
		const send = (code: number, body: unknown) => {
			if (res.headersSent || res.destroyed) return;
			res.writeHead(code, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		answer(req, send).catch((err) => {
			console.error('request failed:', err instanceof Error ? err.message : err);
			send(500, { error: 'brain error' });
		});
	});
	server.listen(PORT, HOST, () => console.log(`brain on http://${HOST}:${PORT} using ${MODEL}`));
}

async function answer(req: IncomingMessage, send: (code: number, body: unknown) => void) {
	if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, model: MODEL });
	if (req.method !== 'POST' || req.url !== '/decide') return send(404, { error: 'POST /decide or GET /health' });
	let raw = '';
	for await (const chunk of req) raw += chunk;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return send(400, { error: 'body is not JSON' });
	}
	const sighting = v.safeParse(Sighting, json);
	if (!sighting.success) return send(400, { error: 'bad sighting', issues: v.flatten(sighting.issues).nested });
	const verdict = await decide(sighting.output);
	console.log(`${sighting.output.name}: ${verdict.action} (${verdict.source}, ${verdict.ms} ms) ${verdict.say}${verdict.error ? ' [' + verdict.error + ']' : ''}`);
	send(200, verdict);
}

// The server keeps conversations in .data/brain.db; a one-off run stays in memory so it never touches
// conversations a running server owns.
if (once < 0) mkdirSync(DATA, { recursive: true });
const flue = await start({ agents: [Greeter], db: once >= 0 ? sqlite() : sqlite(DATA + 'brain.db') });
if (once >= 0) {
	const sighting = v.parse(Sighting, JSON.parse(process.argv[once + 1] ?? '{}'));
	console.log(JSON.stringify(await decide(sighting), null, 2));
	await flue.stop();
} else {
	serve();
}
