// Reads the people table the Python greeter writes (../greeter/greeter.db), read only.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const DB = process.env.GREETER_DB ?? fileURLToPath(new URL('../../../greeter/greeter.db', import.meta.url));

type Row = { id: string; name: string; role: string | null; facts: string | null };

export function findPeople(query: string, limit = 5) {
	if (!query) return [];
	const db = new DatabaseSync(DB, { readOnly: true, timeout: 2000 }); // wait out a write from the Python greeter
	try {
		const exact = db.prepare('select id, name, role, facts from people where id = ? or lower(name) = lower(?)').all(query, query) as Row[];
		const like = '%' + query.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
		const rows = exact.length
			? exact
			: (db.prepare("select id, name, role, facts from people where name like ? escape '\\' order by name limit ?").all(like, limit) as Row[]);
		return rows.map((r) => ({ id: r.id, name: r.name, role: r.role ?? '', talkingPoints: JSON.parse(r.facts || '[]') as string[] }));
	} finally {
		db.close();
	}
}

export const lookupPerson = defineTool({
	name: 'lookup_person',
	description:
		'Look up a Hack Western 13 person the greeter knows, by Slack id or by (part of) their name. ' +
		'Returns up to 5 matches with name, Slack role and researched talking points. An empty list means nobody matched.',
	input: v.object({ query: v.string() }),
	async run({ data }) {
		return { output: findPeople(data.query.trim()) };
	},
});
