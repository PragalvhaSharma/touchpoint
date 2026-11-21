// The conversation server: the Python greeter sends it what a person said (or that they just came
// back) and gets back what to say. Each person has their own durable Flue conversation, keyed by
// their greeter.db id and stored in .data/talk.db, so memory survives restarts.
//
//   npm run talk                                     # http://127.0.0.1:8095
//   curl -s localhost:8095/talk/U0CKWHRFWF6 -d '{"said":"Hi, it is Prag"}'
//
// POST /talk/:id  { said?: string, event?: string, context?: string[] }  ->  { text, ms }
//   said     what they said (a transcript), sent as their turn
//   event    a camera event such as "Prag walked back up to the table after 4 minutes", sent as a signal
//   context  lines already spoken since the last turn ("You said: ..." or "They said: ..."), from the
//            greeting brain or a voice chat, so this conversation stays the whole record
//
// GET /prompt/:id  ->  { prompt }   who this person is and how to talk with them, for the voice session
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import * as v from 'valibot';
import { Companion, companionPrompt } from './agents/companion.ts';
import { MODEL } from './agents/greeter.ts';

const PORT = Number(process.env.GREETER_TALK_PORT ?? 8095);
const HOST = process.env.GREETER_TALK_HOST ?? '127.0.0.1';
const TIMEOUT_MS = Number(process.env.GREETER_TALK_TIMEOUT_MS ?? 25000);
const DATA = fileURLToPath(new URL('../.data/', import.meta.url));

const Turn = v.object({
	said: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
	event: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(1000))),
	context: v.optional(v.array(v.pipe(v.string(), v.maxLength(1000))), []),
});
type Turn = v.InferOutput<typeof Turn>;

// One person's id, or a group's: their ids sorted and joined with "+" (U1+U2), with its own conversation.
const ID = /^[\p{L}\p{N}_ .'-]{1,120}(\+[\p{L}\p{N}_ .'-]{1,120}){0,7}$/u;

// Flue folds a message that arrives mid-turn into the same reply, so run one turn per person at a time.
const queues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(id: string, job: () => Promise<T>): Promise<T> {
	const run = (queues.get(id) ?? Promise.resolve()).then(job, job);
	const tail = run.catch(() => {});
	queues.set(id, tail);
	tail.then(() => queues.get(id) === tail && queues.delete(id));
	return run;
}

export async function talk(id: string, turn: Turn): Promise<{ text: string; ms: number }> {
	const t0 = Date.now();
	const handle = init(Companion, { id });
	const note = turn.context.map((line) => `[${line}]\n`).join('');
	const message = turn.said
		? { kind: 'user' as const, body: note + turn.said }
		: { kind: 'signal' as const, type: 'camera', body: (note + (turn.event ?? '')).trim() };
	const receipt = await handle.dispatch({ message });
	try {
		const reply = await handle.read(receipt, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		// Shown on screen and read aloud; models love dashes, so turn them into commas.
		const text = reply.text.trim().replace(/\s*[\u2013\u2014]\s*/g, ', ');
		return { text, ms: Date.now() - t0 };
	} catch (err) {
		// Don't let a stuck turn block this person's next one.
		if (err instanceof Error && err.name === 'TimeoutError') await handle.abort().catch(() => {});
		throw err;
	}
}

function serve() {
	const server = createServer(async (req, res) => {
		const send = (code: number, body: unknown) => {
			res.writeHead(code, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, model: MODEL });
		const p = url.pathname.match(/^\/prompt\/([^/]+)$/);
		if (req.method === 'GET' && p) {
			const id = decodeURIComponent(p[1]);
			return ID.test(id) ? send(200, { id, prompt: companionPrompt(id) }) : send(400, { error: 'bad id' });
		}
		const m = url.pathname.match(/^\/talk\/([^/]+)$/);
		if (req.method !== 'POST' || !m) return send(404, { error: 'POST /talk/:id or GET /health' });
		const id = decodeURIComponent(m[1]);
		if (!ID.test(id)) return send(400, { error: 'bad id' });
		let raw = '';
		for await (const chunk of req) raw += chunk;
		let json: unknown;
		try {
			json = JSON.parse(raw || '{}');
		} catch {
			return send(400, { error: 'body is not JSON' });
		}
		const turn = v.safeParse(Turn, json);
		if (!turn.success) return send(400, { error: 'bad turn', issues: v.flatten(turn.issues).nested });
		if (!turn.output.said && !turn.output.event) return send(400, { error: 'send said or event' });
		try {
			const out = await oneAtATime(id, () => talk(id, turn.output));
			console.log(`${id} (${out.ms} ms) <- ${turn.output.said ?? '[' + turn.output.event + ']'} -> ${out.text}`);
			send(200, out);
		} catch (err) {
			console.error(id, err);
			send(502, { error: String(err instanceof Error ? err.message : err) });
		}
	});
	server.listen(PORT, HOST, () => console.log(`talk on http://${HOST}:${PORT} using ${MODEL}`));
}

mkdirSync(DATA, { recursive: true });
await start({ agents: [Companion], db: sqlite(DATA + 'talk.db') });
serve();
