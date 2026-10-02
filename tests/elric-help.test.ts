import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELRIC_DOCS_URL, HELP_LIMITS, searchHelp } from '../server/elric/help.js';
import { HELP_INDEX } from '../server/elric/help-index.js';
import { checkToolCall, toolSpecs } from '../server/elric/tools.js';
import { PUBLIC_DOCS } from '../scripts/public-docs/build.js';
import { helpIndexModule } from '../scripts/elric-help-index.js';
import { elricFixture } from './elric-fixture.js';

/**
 * N5: Elric's help tool. Read-only search over the published docs only (the same allow-list and
 * public-safety guard as centralcity.ai/docs), links in every result, no room binding.
 */
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

test('the committed index matches the rendered public docs (regenerate: pnpm tsx scripts/elric-help-index.ts)', async () => {
  assert.equal(
    readFileSync(join(root, 'server/elric/help-index.ts'), 'utf8'),
    await helpIndexModule(root),
  );
});

test('the index holds only published pages, each section with its public link', () => {
  const slugs = new Set(PUBLIC_DOCS.map((doc) => doc.slug));
  assert.ok(HELP_INDEX.length > 20);
  for (const section of HELP_INDEX) {
    assert.ok(slugs.has(section.slug), section.slug);
    assert.equal(section.url, `https://centralcity.ai/docs/${section.slug}.md`);
  }
  assert.ok(HELP_INDEX.some((section) => section.slug === 'elric'));
});

test('search: relevant sections with links, at most 3, capped text; nothing found → only the docs link', () => {
  const tasks = searchHelp('How do tasks work in a room?');
  assert.ok(tasks.results.length >= 1 && tasks.results.length <= HELP_LIMITS.results);
  assert.ok(tasks.results.some((r) => r.url.endsWith('/docs/room-tasks.md')));
  for (const r of tasks.results) assert.ok(r.text.length <= HELP_LIMITS.sectionChars + 1);
  assert.equal(tasks.docs, ELRIC_DOCS_URL);
  const elric = searchHelp('Who can use Elric? Is there an age limit?');
  assert.equal(elric.results[0]!.url, 'https://centralcity.ai/docs/elric.md');
  assert.equal(searchHelp('How do I pause Elric?').results[0]!.section, 'On and off');
  assert.deepEqual(searchHelp('banana smoothie recipes'), { results: [], docs: ELRIC_DOCS_URL });
  assert.deepEqual(searchHelp('the and for'), { results: [], docs: ELRIC_DOCS_URL });
});

test('gate: city_help is offered, takes only a query, never a room; extra arguments are refused', () => {
  assert.ok(toolSpecs(false).some((tool) => tool.name === 'city_help'));
  const ok = checkToolCall({ id: 'a', name: 'city_help', args: { query: 'invites' } }, 'r1', false);
  assert.deepEqual(ok, { ok: true, name: 'city_help', args: { query: 'invites' } });
  for (const args of [
    { query: 'x', room_id: 'r2' },
    { query: '' },
    { query: 'a'.repeat(201) },
    { query: 'bad\u0000' },
    null,
  ])
    assert.deepEqual(checkToolCall({ id: 'b', name: 'city_help', args }, 'r1', true), {
      ok: false,
      status: 'refused_args',
    });
});

test('end to end: Elric looks up the docs and links the page; no room data in the tool result', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric how do join links work?', s.person);
  f.small.push(
    { toolCalls: [{ name: 'city_help', args: { query: 'join links' }, id: 'h1' }] },
    { text: 'See https://centralcity.ai/docs/join-links.md' },
  );
  f.large.push(
    { toolCalls: [{ name: 'city_help', args: { query: 'join links' }, id: 'h1' }] },
    { text: 'See https://centralcity.ai/docs/join-links.md' },
  );
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(result?.outcome, 'ok');
  const requests = [...f.small.requests, ...f.large.requests];
  const toolMessage = requests
    .flatMap((r) => r.messages)
    .find((m) => m.role === 'tool' && m.name === 'city_help');
  assert.ok(toolMessage && toolMessage.role === 'tool');
  const payload = JSON.parse(toolMessage.content) as ReturnType<typeof searchHelp>;
  assert.ok(payload.results.some((r) => r.url.endsWith('/docs/join-links.md')));
  assert.ok(!toolMessage.content.includes(s.room.id));
  assert.ok(!toolMessage.content.includes('how do join links work'));
});

test('Elric asking about itself: "you" questions find the Elric page', () => {
  const self = { self: true };
  const top = (q: string) => searchHelp(q, undefined, self).results[0];
  assert.equal(top('How do I stop you for a while?')!.url, 'https://centralcity.ai/docs/elric.md');
  assert.equal(top('How do I stop you for a while?')!.section, 'On and off');
  assert.equal(top('How do I remove you?')!.url, 'https://centralcity.ai/docs/elric.md');
  assert.ok(
    searchHelp('How many questions can I ask you per day?', undefined, self).results.some(
      (r) => r.section === 'Limits',
    ),
  );
  // Without the caller hint "you" means nothing, and other topics are unaffected.
  assert.notEqual(searchHelp('How do I stop you for a while?').results[0]?.section, 'On and off');
  assert.ok(
    searchHelp('How do I invite someone to a room?', undefined, self).results.every(
      (r) => !r.url.endsWith('/elric.md'),
    ),
  );
});
