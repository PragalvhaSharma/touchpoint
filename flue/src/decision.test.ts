import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arduinoLine, fallback, problemWith, spokenName, type Decision } from './decision.ts';

const d = (over: Partial<Decision>): Decision => ({ action: 'greet', say: 'Hey Alex! You won X. How?', fact: 0, why: 'test', ...over });
const solid = { score: 0.62, bar: 0.45, visit: 1, others: [], minutesSinceLast: null };
const shaky = { ...solid, score: 0.47 };
const justSpoke = { ...solid, visit: 2, minutesSinceLast: 0.5 };

test('a talking point index must exist', () => {
	assert.equal(problemWith(d({ fact: 2 }), 2, 'Alex Li', solid), 'fact must be null or an index from 0 to 1');
	assert.match(problemWith(d({ fact: 0 }), 0, 'Alex Li', solid) ?? '', /no talking points/);
	assert.equal(problemWith(d({ fact: 1 }), 2, 'Alex Li', solid), null);
});

test('the line must address the right person', () => {
	assert.match(problemWith(d({ say: 'Hey Lucian!' }), 3, 'Alex Li', solid) ?? '', /first name \(Alex\)/);
});

test('a shaky match has to be confirmed, without facts', () => {
	assert.match(problemWith(d({}), 3, 'Alex Li', shaky) ?? '', /use confirm/);
	assert.match(problemWith(d({ action: 'confirm', say: 'Hi, are you Alex?' }), 3, 'Alex Li', shaky) ?? '', /fact must be null/);
	assert.equal(problemWith(d({ action: 'confirm', say: 'Hi, are you Alex?', fact: null }), 3, 'Alex Li', shaky), null);
});

test('skip says nothing and sends nothing to the Arduino', () => {
	assert.match(problemWith(d({ action: 'skip', fact: null }), 3, 'Alex Li', justSpoke) ?? '', /leave say empty/);
	assert.equal(problemWith(d({ action: 'skip', say: '', fact: null }), 3, 'Alex Li', justSpoke), null);
	assert.equal(arduinoLine('skip', 'Alex Li'), null);
});

test('nobody gets skipped unless the greeter spoke to them moments ago', () => {
	const skip = d({ action: 'skip', say: '', fact: null });
	assert.match(problemWith(skip, 3, 'Alex Li', solid) ?? '', /skip only when/); // never spoken to (or forgotten after a restart)
	assert.match(problemWith(skip, 3, 'Alex Li', { ...justSpoke, minutesSinceLast: 5 }) ?? '', /skip only when/);
	assert.match(problemWith(skip, 3, 'Alex Li', null) ?? '', /skip only when/);
});

test('usernames are never read aloud', () => {
	assert.equal(spokenName('Alex Li'), 'Alex');
	assert.equal(spokenName("Zoë O'Neil"), 'Zoë');
	assert.equal(spokenName('aelrafi3'), null);
	assert.equal(problemWith(d({ say: 'Hey there! You won X. How?' }), 3, 'aelrafi3', solid), null);
	const fb = fallback({ id: 'U2', name: 'aelrafi3', score: 0.7, bar: 0.45, visit: 1, others: [] }, 'down', 5);
	assert.doesNotMatch(fb.say, /aelrafi3/);
});

test('the Arduino line only carries name characters', () => {
	assert.equal(arduinoLine('greet', 'Alex\nS'), 'P AlexS');
	assert.equal(arduinoLine('confirm', "Zoë O'Neil-Ng"), "P Zoë O'Neil-Ng");
});

test('the fallback never brings up facts and confirms shaky matches', () => {
	const sight = { id: 'U1', name: 'Alex Li', score: 0.47, bar: 0.45, visit: 1, others: [] };
	assert.equal(fallback(sight, 'down', 5).action, 'confirm');
	assert.equal(fallback({ ...sight, score: 0.7 }, 'down', 5).fact, null);
});
