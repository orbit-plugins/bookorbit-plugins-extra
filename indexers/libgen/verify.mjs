/**
 * Exercises the plugin against pages saved from the live site on 2026-08-20, so the parser is
 * tested on the markup it actually has to survive rather than on a fixture written to match it.
 *
 * Run with: node verify.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import plugin from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

const SEARCH_EBOOK = fixture('lg.html'); // "project hail mary", objects=f, topics=l, res=25
const SEARCH_COMIC = fixture('rc.html'); // "batman", objects=f, topics=c, res=25
const ADS_PAGE = fixture('ads.html'); // /ads.php?md5=e7c75dc2964ce80c19cb69140aae8614
// "Rose Madder Stephen King", res=50, pages 1 and 2. Real crowding: 32 Spanish rows against 9
// English on the first page, which is the case that made paging necessary.
const CROWDED_1 = fixture('crowded-page1.html');
const CROWDED_2 = fixture('crowded-page2.html');
// "The Spider Silk Scarf Ana Reyes", which the catalogue does not hold. A zero-hit search drops
// the results table entirely and keeps only the tab bar, so this is what finding nothing looks like.
const NO_HITS = fixture('no-hits.html');
// Both passes for "Dead of Winter" by Darcy Coates, ISBN 9781728270258, captured 2026-08-23. The
// catalogue holds 8 files for this book and states an ISBN on none of them, so the exact pass
// comes back with nothing while the title answers with all 8. This is the case an exact-only
// search reported as unavailable for a book sitting right there.
const ISBN_MISS = fixture('isbn-miss.html'); // res=50, columns=i, req=9781728270258
const ISBN_MISS_TEXT = fixture('isbn-miss-text.html'); // res=50, columns=t,a, req=Dead of Winter Darcy Coates
const EMPTY_TABLE = '<html><table id="tablelibgen"><tbody></tbody></table></html>';

/** Serves a page per `page` parameter, and an empty table past the end. */
function paged(pages) {
  return (url) => res(pages[Number(new URL(url).searchParams.get('page') ?? '1')] ?? EMPTY_TABLE);
}
const isSpanishEdition = (r) => /el retrato/i.test(r.title);

let pass = 0;
let fail = 0;
const ok = (name, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
};

function makeHost(responder) {
  const reqs = [];
  return {
    reqs,
    get calls() {
      return reqs.map((entry) => entry.url);
    },
    fetch: async (url, init) => {
      reqs.push({ url, init });
      return responder(url, init);
    },
    logger: { log: () => {}, warn: () => {} },
    // Mirrors server/src/modules/book-request/indexers/search-text.ts
    buildSearchText: (q) =>
      [q.title.replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(/\s+/g, ' ').trim() || q.title, q.author]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    saveCredential: async () => {},
    fail: (code, message) => Object.assign(new Error(message), { code }),
  };
}

const res = (body, init = {}) => new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
const cfg = (over = {}) => ({
  id: 3,
  name: 'Libgen',
  baseUrl: 'https://libgen.li/',
  credential: null,
  allowPrivateAddress: false,
  categories: { ebook: [], audiobook: [], comic: [] },
  settings: {},
  ...over,
});
const query = {
  title: 'Project Hail Mary (Unabridged)',
  author: 'Andy Weir',
  isbn13: null,
  mediaKind: 'ebook',
  language: null,
  limit: 20,
};

console.log('descriptor');
ok('type slug', plugin.type === 'libgen');
ok('plugin version', plugin.version === '1.0.0');
ok('no credential of any kind', plugin.requiresCredential === false && plugin.credentialKind === null);
ok('resolveFile only', typeof plugin.resolveFile === 'function' && plugin.fetchTorrentFile === undefined);
ok('no seeding', plugin.seedsBack === false);
ok('declares exact ISBN search', plugin.supportsIsbnSearch === true);
ok('media kinds', JSON.stringify(plugin.mediaKinds) === '["ebook","comic"]');

console.log('search against the live ebook page');
{
  const host = makeHost(() => res(SEARCH_EBOOK));
  const out = await plugin.search(query, cfg(), host);
  const url = new URL(host.calls[0]);

  ok('edition qualifier stripped', url.searchParams.get('req') === 'Project Hail Mary Andy Weir', url.searchParams.get('req'));
  ok('searches files', url.searchParams.getAll('objects[]').join() === 'f');
  ok('ebook spans both collections', url.searchParams.getAll('topics[]').join() === 'l,f');
  ok('page size covers the limit', url.searchParams.get('res') === '50', url.searchParams.get('res'));
  ok('scoped to the title and author columns', url.searchParams.getAll('columns[]').join() === 't,a', url.searchParams.getAll('columns[]').join());
  ok('no isbn pass when the request states none', host.calls.length >= 1 && !host.calls.some((c) => new URL(c).searchParams.getAll('columns[]').join() === 'i'));

  ok('rows parsed', out.length > 0, out.length);
  const first = out[0];
  ok('title read from the anchor, not the tooltip', first.title === 'Project Hail Mary', JSON.stringify(first.title));
  ok('no ISBN bleed into the title', !/\d{10}/.test(first.title), first.title);
  ok('author, with the trailing separator trimmed', first.author === 'Andy Weir', JSON.stringify(first.author));
  ok('md5 guid', /^[a-f0-9]{32}$/.test(first.guid), first.guid);
  ok('format', first.format === 'epub', first.format);
  ok('size parsed', first.sizeBytes === 702000, first.sizeBytes);
  ok('language mapped to a code', first.language === 'en', first.language);
  ok('seeders null not zero', first.seeders === null && first.leechers === null);
  ok('one file per release', first.primaryFileCount === 1);
  ok('every row states a usable format', out.every((r) => ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu'].includes(r.format)));
  ok('every row carries an md5', out.every((r) => /^[a-f0-9]{32}$/.test(r.guid)));
  ok('no row has an empty title', out.every((r) => r.title.length > 0));

  const subtitled = out.find((r) => r.bookTitle);
  ok(
    'semicolon title split for scoring',
    !subtitled || (subtitled.title.includes(': ') && !subtitled.bookTitle.includes(';')),
    subtitled && `${subtitled.title} | ${subtitled.bookTitle}`,
  );
  const dated = out.find((r) => r.publishedAt);
  ok('full dates become publishedAt', !dated || dated.publishedAt.endsWith('T00:00:00.000Z'), dated?.publishedAt);
}

console.log('search against the live comics page');
{
  const host = makeHost(() => res(SEARCH_COMIC));
  const out = await plugin.search({ ...query, title: 'Batman', author: null, mediaKind: 'comic' }, cfg(), host);
  const url = new URL(host.calls[0]);
  ok('comic collection', url.searchParams.getAll('topics[]').join() === 'c');
  ok('comic rows parsed', out.length > 0, out.length);
  ok('comic formats only', out.every((r) => ['cbz', 'cb7', 'pdf'].includes(r.format)), [...new Set(out.map((r) => r.format))]);
  ok('comic rows carry an md5 from the keyless link', out.every((r) => /^[a-f0-9]{32}$/.test(r.guid)));

  const issue = out[0];
  ok('series prepended to the issue designation', /^\S.*#/.test(issue.title) && !issue.title.startsWith('#'), issue.title);
  ok('series is what gets scored', issue.bookTitle && !issue.bookTitle.includes('#'), issue.bookTitle);
  ok('every comic title names something before the issue', out.every((r) => !r.title.startsWith('#')), out.map((r) => r.title).slice(0, 3));
}

console.log('search options and failures');
{
  const host = makeHost(() => res(SEARCH_EBOOK));
  const out = await plugin.search({ ...query, limit: 3 }, cfg(), host);
  ok('limit honoured', out.length <= 3, out.length);
  ok('a filled limit costs one request', host.calls.length === 1, host.calls.length);
  ok('no page parameter on the first page', new URL(host.calls[0]).searchParams.has('page') === false);
}
{
  const host = makeHost(() => res(SEARCH_EBOOK));
  await plugin.search(query, cfg(), host);
  ok('a short page stops the paging', host.calls.length === 1, host.calls.length);
}
{
  const host = makeHost(() => res(SEARCH_EBOOK));
  const out = await plugin.search(query, cfg({ settings: { ebookFormats: 'mobi' } }), host);
  ok('format setting narrows results', out.every((r) => r.format === 'mobi'));
}
{
  const host = makeHost(() => res(SEARCH_EBOOK));
  const err = await plugin.search(query, cfg({ settings: { ebookFormats: 'm4b,flac' } }), host).catch((e) => e);
  ok('no usable format is unsupportedMedium', err.code === 'unsupportedMedium', err.code);
  ok('and costs no request', host.calls.length === 0);
}
{
  const host = makeHost(() => res('<html><body><p>nothing like this site</p></body></html>'));
  const err = await plugin.search(query, cfg(), host).catch((e) => e);
  ok('missing table is not reported as empty', err.code === 'unreachable', err.code);
}
{
  const host = makeHost(() => res(NO_HITS));
  const out = await plugin.search(query, cfg(), host).catch((e) => e);
  ok('a zero-hit page is empty, not a failure', Array.isArray(out) && out.length === 0, out.code ?? out);
  ok('and costs exactly one request', host.calls.length === 1, host.calls.length);
}
console.log('the isbn pass');
{
  const host = makeHost((url) => res(new URL(url).searchParams.getAll('columns[]').join() === 'i' ? SEARCH_EBOOK : NO_HITS));
  const out = await plugin.search({ ...query, isbn13: '9780593135211' }, cfg(), host);
  const first = new URL(host.calls[0]);
  ok('the isbn pass goes first', first.searchParams.getAll('columns[]').join() === 'i', first.searchParams.getAll('columns[]').join());
  ok('and searches the isbn, not the title', first.searchParams.get('req') === '9780593135211', first.searchParams.get('req'));
  ok('its rows are kept', out.length > 0, out.length);
  ok(
    'and the text pass that follows it searches the title',
    host.calls.length === 2 && new URL(host.calls[1]).searchParams.getAll('columns[]').join() === 't,a',
    host.calls.length,
  );
}
{
  // Both passes answer, with no row in common. The exact edition is what the request asked for,
  // so it has to lead whatever the recovery adds behind it.
  const host = makeHost((url) => res(new URL(url).searchParams.getAll('columns[]').join() === 'i' ? SEARCH_EBOOK : ISBN_MISS_TEXT));
  const exactOnly = await plugin.search({ ...query, isbn13: '9780593135211' }, cfg(), makeHost(() => res(SEARCH_EBOOK)));
  const out = await plugin.search({ ...query, isbn13: '9780593135211' }, cfg(), host);
  const exactGuids = exactOnly.map((r) => r.guid);
  ok('exact rows come before the recovery rows', out.slice(0, exactGuids.length).every((r, i) => r.guid === exactGuids[i]), out.slice(0, 3).map((r) => r.title));
  ok('and the recovery is added rather than replacing them', out.length > exactGuids.length, [exactGuids.length, out.length]);
}
{
  const host = makeHost(() => res(NO_HITS));
  await plugin.search({ ...query, isbn13: '9780593135211', isbn13s: ['9780593135211', '9781111111111'] }, cfg(), host);
  const isbnCalls = host.calls
    .map((url) => new URL(url))
    .filter((url) => url.searchParams.getAll('columns[]').join() === 'i')
    .map((url) => url.searchParams.get('req'));
  ok('only the active isbn gets an exact pass', JSON.stringify(isbnCalls) === '["9780593135211"]', isbnCalls);
}
{
  // The bug this pair of fixtures exists for: an ISBN the catalogue does not state against any of
  // its rows used to end the search, reporting 8 files as no matches.
  const host = makeHost((url) => res(new URL(url).searchParams.getAll('columns[]').join() === 'i' ? ISBN_MISS : ISBN_MISS_TEXT));
  const out = await plugin.search({ ...query, title: 'Dead of Winter', author: 'Darcy Coates', isbn13: '9781728270258' }, cfg(), host);
  const [exact, text] = host.calls.map((url) => new URL(url));

  ok('an isbn stated on no row falls back to title and author', out.length === 8, out.length);
  ok('the exact pass still went first', exact.searchParams.getAll('columns[]').join() === 'i' && exact.searchParams.get('req') === '9781728270258');
  ok(
    'and the recovery searches the title, not the isbn',
    text?.searchParams.getAll('columns[]').join() === 't,a' && text.searchParams.get('req') === 'Dead of Winter Darcy Coates',
    text?.searchParams.get('req'),
  );
  ok('the rows really are the book', out.every((r) => r.title === 'Dead of Winter'), [...new Set(out.map((r) => r.title))]);
  ok('including the epubs the exact pass reported as unavailable', out.filter((r) => r.format === 'epub').length === 4, out.map((r) => r.format));
  ok('recovery costs one extra request, not a page walk', host.calls.length === 2, host.calls.length);
}
{
  // A zero-hit exact pass is not a reachability problem, and the recovery coming back empty too
  // must not turn into one: the request genuinely has nothing here.
  const host = makeHost(() => res(ISBN_MISS));
  const out = await plugin.search({ ...query, isbn13: '9781728270258' }, cfg(), host).catch((e) => e);
  ok('both passes empty is an empty result, not a failure', Array.isArray(out) && out.length === 0, out.code ?? out);
}
{
  // The recovery is a bonus query. It has already been proved that the mirror answers, so a
  // mirror that falls over on the second request must not lose the search.
  const host = makeHost((url) => {
    if (new URL(url).searchParams.getAll('columns[]').join() === 'i') return res(SEARCH_EBOOK);
    throw new Error('connection reset');
  });
  const out = await plugin.search({ ...query, isbn13: '9780593135211' }, cfg(), host).catch((e) => e);
  ok('a failed recovery keeps the exact rows', Array.isArray(out) && out.length > 0, out.code ?? out);
}
{
  const host = makeHost((url) => (new URL(url).searchParams.getAll('columns[]').join() === 'i' ? res('boom', { status: 500 }) : res(SEARCH_EBOOK)));
  const out = await plugin.search({ ...query, isbn13: '9780593135211' }, cfg(), host).catch((error) => error);
  ok('an isbn pass that fails outright does not fail the search', Array.isArray(out) && out.length > 0, out.code ?? out);
  ok('and the text pass still ran', host.calls.length === 2, host.calls.length);
}
{
  const host = makeHost(() => res('boom', { status: 500 }));
  const err = await plugin.search({ ...query, isbn13: '9780593135211' }, cfg(), host).catch((error) => error);
  ok('both passes failing does fail the search', err.code === 'error', err.code);
  ok('and it reports the first failure rather than swallowing it', /500/.test(err.message), err.message);
}
{
  const host = makeHost(() => res(SEARCH_EBOOK));
  const out = await plugin.search({ ...query, isbn13: '9780593135211', limit: 2 }, cfg(), host);
  ok('a filled limit stops before the text pass', host.calls.length === 1, host.calls.length);
  ok('and returns the limit', out.length === 2, out.length);
}

console.log('isbns off the row');
{
  const host = makeHost(() => res(SEARCH_EBOOK));
  const out = await plugin.search(query, cfg(), host);
  const withIsbn = out.filter((r) => r.isbn);
  ok('rows carry the isbns the catalogue states', withIsbn.length > 0, withIsbn.length);
  ok('every emitted value is ten or thirteen characters', withIsbn.every((r) => r.isbn.split('; ').every((i) => i.length === 10 || i.length === 13)), JSON.stringify(withIsbn[0]?.isbn));
  ok('the multi-isbn row keeps all six', out.some((r) => r.isbn === '9780593135204; 0593135202; 9780593135211; 0593135210; 9780593355275; 059335527X'), JSON.stringify(out.map((r) => r.isbn).filter(Boolean)));
  ok('a row with no isbn omits the field rather than sending an empty one', out.every((r) => r.isbn === undefined || r.isbn.length > 0));
}
{
  const host = makeHost(() => res(SEARCH_COMIC));
  const out = await plugin.search({ ...query, title: 'Batman', author: null, mediaKind: 'comic' }, cfg(), host);
  const url = new URL(host.calls[0]);
  ok('a comic keeps the series column', url.searchParams.getAll('columns[]').join() === 't,a,s', url.searchParams.getAll('columns[]').join());
  ok('comic rows still parse', out.length > 0, out.length);
}

{
  const host = makeHost(() => res('slow down', { status: 429 }));
  const err = await plugin.search(query, cfg(), host).catch((e) => e);
  ok('429 throttled', err.code === 'throttled', err.code);
}
{
  const host = makeHost(() => res('boom', { status: 500 }));
  const err = await plugin.search(query, cfg(), host).catch((e) => e);
  ok('500 carries the mirror wording', err.code === 'error' && err.message.includes('500'), err.message);
}
{
  const host = makeHost(() => res(SEARCH_EBOOK));
  await plugin.search(query, cfg(), host);
  const h = host.reqs[0].init.headers;
  ok('browser user agent', h['User-Agent'].startsWith('Mozilla/5.0'));
  ok('accept-language is not a wildcard', h['Accept-Language'] === 'en-US,en;q=0.9');
}

console.log('paging past a crowded page');
{
  const host = makeHost(paged({ 1: CROWDED_1, 2: CROWDED_2 }));
  const out = await plugin.search({ ...query, title: 'Rose Madder', author: 'Stephen King', language: 'en', limit: 20 }, cfg(), host);

  ok('a full page of the wrong language is paged past', host.calls.length >= 2, host.calls.length);
  ok('page parameter set on the second request', new URL(host.calls[1]).searchParams.get('page') === '2');
  ok('found more than the first page could give', out.length > 0, out.length);
  ok('every result is english or unstated', out.every((r) => r.language === 'en' || r.language === undefined), [...new Set(out.map((r) => r.language))]);
  ok('no spanish edition survived', !out.some(isSpanishEdition), out.filter(isSpanishEdition).map((r) => r.title)[0]);
  ok('no duplicates across pages', new Set(out.map((r) => r.guid)).size === out.length);
}
{
  // The case that started this: the request stated a three-letter code, and only the shared
  // ISO map turns it into the two-letter one the rows are reported in.
  const host = makeHost(paged({ 1: CROWDED_1, 2: CROWDED_2 }));
  const out = await plugin.search({ ...query, title: 'Rose Madder', author: 'Stephen King', language: 'spa', limit: 10 }, cfg(), host);
  ok('spa matches rows reported as es', out.length > 0 && out.every((r) => r.language === 'es' || r.language === undefined), [
    out.length,
    [...new Set(out.map((r) => r.language))],
  ]);
  ok('and those really are the spanish edition', out.some(isSpanishEdition));
}
{
  // A language the page cannot satisfy: it must stop, not spin.
  const host = makeHost(() => res(CROWDED_1));
  const out = await plugin.search({ ...query, title: 'Rose Madder', author: 'Stephen King', language: 'ja', limit: 20 }, cfg(), host);
  ok('gives up at the page cap', host.calls.length === 4, host.calls.length);
  ok('and reports nothing rather than the wrong language', out.length === 0, out.length);
}
{
  const host = makeHost(() => res(CROWDED_1));
  const out = await plugin.search({ ...query, title: 'Rose Madder', author: 'Stephen King', language: null, limit: 200 }, cfg(), host);
  ok('a repeated page is deduped rather than counted twice', new Set(out.map((r) => r.guid)).size === out.length, out.length);
}
{
  const host = makeHost(paged({ 1: CROWDED_1, 2: CROWDED_2 }));
  const out = await plugin.search(
    { ...query, title: 'Rose Madder', author: 'Stephen King', language: 'en', limit: 20 },
    cfg({ settings: { ebookFormats: 'epub' } }),
    host,
  );
  ok('format and language filter together', out.every((r) => r.format === 'epub' && (r.language === 'en' || r.language === undefined)));
}

{
  // A later page that fails must not discard what the earlier ones found.
  let n = 0;
  const host = makeHost(() => {
    n += 1;
    if (n === 1) return res(CROWDED_1);
    throw new Error('connection reset');
  });
  const out = await plugin.search({ ...query, title: 'Rose Madder', author: 'Stephen King', language: 'en', limit: 20 }, cfg(), host);
  ok('a failed later page keeps the earlier rows', out.length > 0, out.length);
  ok('and stops rather than retrying to the cap', host.calls.length === 2, host.calls.length);
}
{
  const host = makeHost(() => {
    throw new Error('connection reset');
  });
  const err = await plugin.search({ ...query, language: 'en' }, cfg(), host).catch((e) => e);
  ok('a failed first page still fails the search', err instanceof Error && /connection reset/.test(err.message), err?.message);
}

console.log('resolveFile against the live ads page');
const release = { guid: 'e7c75dc2964ce80c19cb69140aae8614', title: 'Dune: A Novel', format: 'epub', sizeBytes: 702000 };
{
  const host = makeHost(() => res(ADS_PAGE));
  const file = await plugin.resolveFile(release, cfg(), host);
  ok('asks the ads page', host.calls[0] === `https://libgen.li/ads.php?md5=${release.guid}`, host.calls[0]);
  ok('keyed link extracted', /^https:\/\/libgen\.li\/get\.php\?md5=[a-f0-9]{32}&key=[A-Z0-9]+$/.test(file.url), file.url);
  ok('filename from the release', file.fileName === 'Dune A Novel.epub', file.fileName);
  ok('format and size carried', file.format === 'epub' && file.sizeBytes === 702000);
}
{
  const host = makeHost(() => res('<html><body>no link here</body></html>'));
  const file = await plugin.resolveFile(release, cfg(), host);
  ok('falls back to the keyless link', file.url === `https://libgen.li/get.php?md5=${release.guid}`, file.url);
}
{
  const host = makeHost(() => res(ADS_PAGE));
  const err = await plugin.resolveFile({ ...release, guid: 'not-an-md5' }, cfg(), host).catch((e) => e);
  ok('bad guid refused before any request', host.calls.length === 0 && err.code === 'error');
}
{
  const host = makeHost(() => res(ADS_PAGE));
  const err = await plugin.resolveFile({ ...release, format: undefined }, cfg(), host).catch((e) => e);
  ok('a release with no format is refused, not guessed', err.code === 'error', err.message);
}

console.log('test()');
{
  const host = makeHost(() => res(SEARCH_EBOOK));
  const out = await plugin.test(cfg(), host);
  ok('test succeeds on a real page', out.success === true && out.indexerName === 'Library Genesis');
}
{
  const host = makeHost(() => res('<html>not this site</html>'));
  const out = await plugin.test(cfg(), host);
  ok('test fails on a page with no table', out.success === false, out.error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
