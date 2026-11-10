/**
 * Exercises the plugin against a stubbed host. The search fixtures are live anonymous searches
 * saved on 2026-10-19, with the signed reader links, cover URLs and page links left out. The
 * profile and file answers are written by hand, because a saved one would carry an account's
 * identifiers.
 *
 * The plugin remembers the working mirror per indexer id, so every block uses an id of its own.
 *
 * Run with: node verify.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import plugin from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const AWAKENED = fixture('search-awakened.json');
const ISBN_DUNE = fixture('search-isbn-dune.json');

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
  const logs = [];
  return {
    reqs,
    logs,
    get calls() {
      return reqs.map((entry) => entry.url);
    },
    fetch: async (url, init) => {
      reqs.push({ url, init });
      return responder(url, init);
    },
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    // Mirrors server/src/modules/book-request/indexers/search-text.ts
    buildSearchText: (q) =>
      [q.title.replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(/\s+/g, ' ').trim() || q.title, q.author]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    saveCredential: async () => undefined,
    // The real host's IndexerSearchException carries the code as `failure`.
    fail: (failure, message) => Object.assign(new Error(message), { failure }),
  };
}

const res = (body, init = {}) => new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
const json = (value, init) => res(JSON.stringify(value), init);
const unreachable = () => {
  throw Object.assign(new Error('could not be resolved'), { failure: 'unreachable' });
};
const wall = () => res('<html><center>DiamWall</center></html>', { status: 307, headers: { location: 'https://z-library.sk/eapi/book/search' } });

let nextId = 5000;
const cfg = (over = {}) => ({
  id: nextId++,
  name: 'Z-Library',
  baseUrl: 'https://z-lib.gd',
  credential: '12345678:0123456789abcdef0123456789abcdef',
  allowPrivateAddress: false,
  categories: { ebook: [], audiobook: [] },
  settings: null,
  ...over,
});
const query = (over = {}) => ({
  title: 'Awakened',
  author: 'Bernadette Blackthorn',
  isbn13: null,
  isbn13s: [],
  mediaKind: 'ebook',
  language: null,
  limit: 30,
  ...over,
});
const form = (init) => new URLSearchParams(init.body);

const BOOK = AWAKENED.books.find((book) => book.id === 129316134);
const DUNE = ISBN_DUNE.books.find((book) => book.identifier.includes('9780441013593') && book.title === 'Dune');
const PDF = { ...BOOK, id: 7, hash: 'abc123', extension: 'pdf' };
const searchAnswer = (books) => json({ success: 1, books, exactBooksCount: books.length, pagination: { limit: 30, current: 1, next: false } });

console.log('declaration');
ok('targets the contract this build speaks', plugin.apiVersion === 1);
ok('plugin version', plugin.version === '1.0.0');
ok('signed update channel', plugin.update?.manifestUrl.endsWith('/updates/zlibrary.json') && plugin.update.ed25519PublicKey.length === 43);
ok('needs a session credential', plugin.requiresCredential === true && plugin.credentialKind === 'sessionId');
ok('carries ebooks only', JSON.stringify(plugin.mediaKinds) === '["ebook"]');
ok('serves the file itself', typeof plugin.resolveFile === 'function' && plugin.fetchTorrentFile === undefined);
ok('seeds nothing and uses no categories', plugin.seedsBack === false && plugin.usesCategories === false);
ok('defaults to a mirror, not a walled main domain', plugin.defaultBaseUrl === 'https://z-lib.by');
ok('offers formats, an e-mail and mirrors', plugin.settingsFields.map((f) => f.key).join() === 'ebookFormats,email,mirrors');

console.log('search requests');
{
  const host = makeHost(() => searchAnswer([BOOK]));
  await plugin.search(query(), cfg(), host);
  const { url, init } = host.reqs[0];
  const body = form(init);
  ok('posts to the app API on the base URL', url === 'https://z-lib.gd/eapi/book/search' && init.method === 'POST');
  ok('sends a form body', init.headers['Content-Type'] === 'application/x-www-form-urlencoded');
  ok('searches the cleaned title and author', body.get('message') === 'Awakened Bernadette Blackthorn');
  ok('filters formats at the site', body.getAll('extensions[]').join() === 'epub,mobi,azw,azw3,fb2,djvu');
  ok('asks for the request limit', body.get('limit') === '30');
  ok('sends no language filter when none was asked for', body.getAll('languages[]').length === 0);
  ok('sends no session to a search', init.headers.Cookie === undefined);
  ok('never follows a redirect', init.redirect === 'manual');
}
{
  const host = makeHost(() => searchAnswer([]));
  await plugin.search(query({ language: 'swe' }), cfg(), host);
  ok('maps a three-letter language to the site name', form(host.reqs[0].init).getAll('languages[]').join() === 'swedish');
}
{
  const host = makeHost(() => searchAnswer([]));
  await plugin.search(query({ language: 'en-GB' }), cfg(), host);
  ok('maps a regional tag to its language', form(host.reqs[0].init).getAll('languages[]').join() === 'english');
}
{
  const host = makeHost(() => searchAnswer([]));
  await plugin.search(query({ language: 'tlh' }), cfg(), host);
  ok('leaves an unmapped language unfiltered', form(host.reqs[0].init).getAll('languages[]').length === 0);
}
{
  const host = makeHost(() => searchAnswer([]));
  await plugin.search(query(), cfg({ settings: { ebookFormats: 'EPUB, .azw3, pdf' } }), host);
  ok('reads configured formats and drops unaccepted ones', form(host.reqs[0].init).getAll('extensions[]').join() === 'epub,azw3');
}
{
  const host = makeHost(() => searchAnswer([]));
  await plugin.search(query({ limit: 500 }), cfg(), host);
  ok('caps the page size', form(host.reqs[0].init).get('limit') === '100');
}
{
  const host = makeHost(() => searchAnswer([]));
  let threw = null;
  try {
    await plugin.search(query({ mediaKind: 'audiobook' }), cfg(), host);
  } catch (error) {
    threw = error;
  }
  ok('refuses audiobooks as unsupported', threw?.failure === 'unsupportedMedium' && host.reqs.length === 0);
}

console.log('isbn pass');
{
  const host = makeHost((url, init) => (form(init).get('message') === '9780441013593' ? searchAnswer([DUNE]) : searchAnswer([DUNE, BOOK])));
  const found = await plugin.search(query({ title: 'Dune', author: 'Frank Herbert', isbn13: '9780441013593', limit: 10 }), cfg(), host);
  ok('searches the ISBN first, then the text', host.reqs.map((r) => form(r.init).get('message')).join('|') === '9780441013593|Dune Frank Herbert');
  ok('keeps the ISBN hit first and deduplicates it', found.map((r) => r.guid).join() === `${DUNE.id}-${DUNE.hash},129316134-a03568`);
}
{
  const host = makeHost(() => searchAnswer(Array.from({ length: 10 }, (_, i) => ({ ...DUNE, id: 100 + i }))));
  const found = await plugin.search(query({ isbn13: '9780441013593', limit: 4 }), cfg(), host);
  ok('holds the ISBN pass to half the limit', host.reqs.length === 2 && found.length === 4);
}

console.log('release rows');
{
  const host = makeHost(() => searchAnswer([BOOK, DUNE, PDF, { ...BOOK, id: 8, deleted: 1 }, { ...BOOK, id: 9, hash: '' }]));
  const [book, dune, ...rest] = await plugin.search(query(), cfg(), host);
  ok('identifies a release by book id and hash', book.guid === '129316134-a03568');
  ok('keeps the full title', book.title === 'Awakened (The Last Daughter Book 2)');
  ok('scores against the title without its series', book.bookTitle === 'Awakened');
  ok('states no bare title when there is nothing to strip', dune.bookTitle === undefined);
  ok('reads the author', book.author === 'Blackthorn, Bernadette');
  ok('reads the language as a code', book.language === 'en');
  ok('reads size in bytes', book.sizeBytes === 1990502);
  ok('reads the format', book.format === 'epub' && dune.format === 'mobi');
  ok('reports no swarm, rather than a dead one', book.seeders === null && book.leechers === null);
  ok('is one file', book.primaryFileCount === 1);
  ok('reads both ISBN forms', dune.isbn === '9780441013593; 0441013597');
  ok('states no ISBN where the site has none', book.isbn === undefined);
  ok('drops other formats, deleted rows and rows with no hash', rest.length === 0);
}

console.log('saved searches');
{
  const host = makeHost(() => json(AWAKENED));
  const found = await plugin.search(query(), cfg(), host);
  ok('reads every row of a real answer', found.length === AWAKENED.books.length, found.length);
  ok('finds the requested book', found.filter((r) => r.bookTitle === 'Awakened' || r.title === 'Awakened').length >= 2);
}
{
  const host = makeHost(() => json(ISBN_DUNE));
  const found = await plugin.search(query({ title: 'Dune', author: 'Frank Herbert', isbn13: '9780441013593', limit: 10 }), cfg(), host);
  ok('reads the ISBNs of a real ISBN answer', found.length > 0 && found.every((r) => r.isbn?.includes('9780441013593')));
}

console.log('mirror failover');
{
  const host = makeHost((url) => (url.startsWith('https://z-lib.gd/') ? unreachable() : searchAnswer([BOOK])));
  const config = cfg();
  const found = await plugin.search(query(), config, host);
  ok('moves past an unreachable base URL', found.length === 1 && host.calls[1].startsWith('https://z-lib.by/'));
  await plugin.search(query(), config, host);
  ok('starts the next call at the mirror that answered', host.calls[2].startsWith('https://z-lib.by/'));
}
{
  const host = makeHost((url) => (url.startsWith('https://z-library.sk/') ? wall() : searchAnswer([BOOK])));
  const found = await plugin.search(query(), cfg({ baseUrl: 'https://z-library.sk' }), host);
  ok('treats a redirect as a wall and moves on', found.length === 1 && host.calls.length === 2 && host.calls[1].startsWith('https://z-lib.by/'));
}
{
  const host = makeHost((url) =>
    url.startsWith('https://z-lib.gd/') ? res('<title>Checking your browser ...</title>', { status: 503 }) : searchAnswer([BOOK]),
  );
  const found = await plugin.search(query(), cfg(), host);
  ok('treats a browser check page as a dead mirror', found.length === 1 && host.calls.length === 2);
}
{
  const host = makeHost((url) => (url.startsWith('https://mine.example/') ? searchAnswer([BOOK]) : unreachable()));
  await plugin.search(query(), cfg({ settings: { mirrors: 'mine.example' } }), host);
  ok('uses configured mirrors in place of the built-in list', host.calls.join() === 'https://z-lib.gd/eapi/book/search,https://mine.example/eapi/book/search');
}
{
  const host = makeHost(unreachable);
  let threw = null;
  try {
    await plugin.search(query(), cfg({ settings: { mirrors: 'a.example,b.example' } }), host);
  } catch (error) {
    threw = error;
  }
  ok('reports every mirror it tried when none answer', threw?.failure === 'unreachable' && /a\.example unreachable; b\.example unreachable/.test(threw.message), threw?.message);
}
{
  const host = makeHost(() => {
    throw Object.assign(new Error('boom'), { failure: 'error' });
  });
  let threw = null;
  try {
    await plugin.search(query(), cfg(), host);
  } catch (error) {
    threw = error;
  }
  ok('does not fail over on an error that is not about reaching the mirror', threw?.message === 'boom' && host.reqs.length === 1);
}
{
  const host = makeHost(() => res('', { status: 429 }));
  let threw = null;
  try {
    await plugin.search(query(), cfg(), host);
  } catch (error) {
    threw = error;
  }
  ok('reports rate limiting as throttled', threw?.failure === 'throttled' && host.reqs.length === 1);
}

console.log('domain discovery');
{
  const host = makeHost((url) => {
    if (url.endsWith('/eapi/info/domains')) {
      return json({
        success: 1,
        domains: [
          { domain: 'new-mirror.example', contentAvailable: true, isRedirector: false },
          { domain: 'redirector.example', contentAvailable: true, isRedirector: true },
          { domain: 'empty.example', contentAvailable: false, isRedirector: false },
        ],
      });
    }
    return url.startsWith('https://new-mirror.example/') ? searchAnswer([BOOK]) : unreachable();
  });
  const config = cfg({ settings: { mirrors: 'dead.example' } });
  await plugin.keepalive(config, host);
  const found = await plugin.search(query(), config, host);
  ok('keepalive reads the site domain list', host.calls[0] === 'https://z-lib.gd/eapi/info/domains');
  ok('a listed domain is tried after the configured ones', found.length === 1 && host.calls.slice(1).join() === 'https://z-lib.gd/eapi/book/search,https://dead.example/eapi/book/search,https://new-mirror.example/eapi/book/search', host.calls);
  ok('skips redirectors and domains without content', !host.calls.some((url) => /redirector|empty/.test(url)));

  const before = host.reqs.length;
  const other = await plugin.search(query(), cfg({ settings: { mirrors: 'dead.example' } }), host).catch((error) => error);
  ok('keeps one indexer\'s listed domains away from another', other?.failure === 'unreachable' && !host.calls.slice(before).some((url) => url.includes('new-mirror')));

  host.reqs.length = 0;
  const tested = await plugin.test({ ...config, credential: '12345678:0123456789abcdef' }, host);
  ok('never sends the session to a listed domain', !tested.success && host.calls.length > 0 && !host.calls.some((url) => url.includes('new-mirror')), host.calls);

  host.reqs.length = 0;
  await plugin.test({ ...config, credential: 'hunter2', settings: { mirrors: 'dead.example', email: 'me@example.com' } }, host);
  ok('never sends the password to a listed domain', host.calls.length > 0 && !host.calls.some((url) => url.includes('new-mirror')), host.calls);
}

console.log('session');
{
  const host = makeHost(() => json({ success: 1, user: { id: 12345678, downloads_today: 3, downloads_limit: 10 } }));
  const result = await plugin.test(cfg(), host);
  ok('tests against the profile', host.calls[0] === 'https://z-lib.gd/eapi/user/profile' && host.reqs[0].init.method === 'GET');
  ok('sends the session as cookies', host.reqs[0].init.headers.Cookie === 'remix_userid=12345678; remix_userkey=0123456789abcdef0123456789abcdef');
  ok('and probes search without the session', host.calls[1] === 'https://z-lib.gd/eapi/book/search' && host.reqs[1].init.headers.Cookie === undefined);
  ok('reports the daily allowance', result.success === true && result.indexerName === 'Z-Library (7 of 10 downloads left today)', result);
}
{
  // Main domains answer `/eapi/user/profile` while redirecting `/eapi/book/search` into DiamWall.
  const host = makeHost((url) => (url.endsWith('/eapi/user/profile') ? json({ success: 1, user: {} }) : wall()));
  const result = await plugin.test(cfg({ baseUrl: 'https://z-lib.sk', settings: { mirrors: 'https://z-library.sk' } }), host);
  ok('fails the test when every mirror walls search behind a redirect', result.success === false && /z-lib\.sk answered 307/.test(result.error), result);
}
{
  const host = makeHost((url) => {
    if (url.endsWith('/eapi/user/profile')) return json({ success: 1, user: {} });
    return url.startsWith('https://z-lib.sk/') ? wall() : searchAnswer([BOOK]);
  });
  const config = cfg({ baseUrl: 'https://z-lib.sk', settings: { mirrors: 'https://z-lib.by' } });
  const result = await plugin.test(config, host);
  await plugin.search(query(), config, host);
  ok('switches to a fallback mirror when the base URL walls search during test', result.success === true && host.calls.at(-1) === 'https://z-lib.by/eapi/book/search', host.calls);
}
{
  const host = makeHost(() => json({ success: 1, user: {} }));
  await plugin.test(cfg({ credential: 'remix_userid=42; remix_userkey=deadbeef' }), host);
  ok('accepts the cookie pair pasted from a browser', host.reqs[0].init.headers.Cookie === 'remix_userid=42; remix_userkey=deadbeef');
}
{
  const host = makeHost(() => json({ success: 0, error: 'Please login' }, { status: 400 }));
  const result = await plugin.test(cfg(), host);
  ok('reports a rejected session', result.success === false && /rejected the session/.test(result.error) && host.reqs.length === 1, result);
}
{
  const host = makeHost(() => json({ success: 0, error: 'Invalid credentials' }, { status: 400 }));
  const result = await plugin.test(cfg(), host);
  ok('reads invalid credentials as a rejected session', /rejected the session \(Invalid credentials\)/.test(result.error ?? ''), result);
}
{
  const host = makeHost(() => json({ success: 1 }));
  const missing = await plugin.test(cfg({ credential: null }), host);
  const malformed = await plugin.test(cfg({ credential: 'not a session' }), host);
  ok('refuses a missing or malformed session before calling out', !missing.success && !malformed.success && host.reqs.length === 0);
  ok('says once what a missing session should be', (missing.error.match(/remix_userid/g) ?? []).length === 1, missing.error);
}

console.log('password login');
const passwordCfg = (over = {}) => cfg({ credential: 'hunter2', settings: { email: 'me@example.com' }, ...over });
const loginAnswer = () => json({ success: 1, user: { id: 777, email: 'me@example.com', remix_userkey: 'feedface0123' } });
const profileAnswer = () => json({ success: 1, user: { downloads_today: 1, downloads_limit: 10 } });
{
  const host = makeHost((url) => (url.endsWith('/eapi/user/login') ? loginAnswer() : profileAnswer()));
  const config = passwordCfg();
  const result = await plugin.test(config, host);
  const body = form(host.reqs[0].init);
  ok('logs in with the e-mail and password', host.calls[0] === 'https://z-lib.gd/eapi/user/login' && host.reqs[0].init.method === 'POST' && body.get('email') === 'me@example.com' && body.get('password') === 'hunter2');
  ok('uses the session the login returned', host.reqs[1].init.headers.Cookie === 'remix_userid=777; remix_userkey=feedface0123');
  ok('names the account in the test result', result.success && result.indexerName === 'Z-Library (me@example.com) (9 of 10 downloads left today)', result);
  ok('never saves the session over the password', !host.logs.some((m) => /feedface|hunter2/.test(m)));
  await plugin.test(config, host);
  ok('reuses the session rather than logging in again', host.calls.filter((url) => url.endsWith('/login')).length === 1);
  await plugin.test({ ...config, credential: 'changed' }, host);
  ok('logs in again when the password changes', host.calls.filter((url) => url.endsWith('/login')).length === 2);
}
{
  let profiles = 0;
  const host = makeHost((url) => {
    if (url.endsWith('/eapi/user/login')) return loginAnswer();
    if (url.endsWith('/eapi/book/search')) return searchAnswer([BOOK]);
    profiles += 1;
    return profiles === 2 ? json({ success: 0, error: 'Please login' }, { status: 400 }) : profileAnswer();
  });
  const config = passwordCfg();
  await plugin.test(config, host);
  const result = await plugin.test(config, host);
  ok('replaces a rejected session with one fresh login', result.success && host.calls.filter((url) => url.endsWith('/login')).length === 2 && profiles === 3, host.calls);
}
{
  const host = makeHost((url) => (url.endsWith('/eapi/user/login') ? loginAnswer() : json({ success: 0, error: 'Please login' }, { status: 400 })));
  const result = await plugin.test(passwordCfg(), host);
  ok('does not loop when a fresh session is rejected too', !result.success && host.calls.filter((url) => url.endsWith('/login')).length === 1, host.calls);
}
{
  const host = makeHost(() => json({ success: 0, error: 'Incorrect email or password' }, { status: 400 }));
  const config = passwordCfg();
  const first = await plugin.test(config, host);
  const second = await plugin.test(config, host);
  ok('reports a refused password', /refused the login \(Incorrect email or password\)\. Check the e-mail and password/.test(first.error ?? ''), first);
  ok('does not retry a refused password straight away', host.reqs.length === 1 && /Not retried until/.test(second.error ?? ''), second);
  await plugin.test({ ...config, credential: 'fixed' }, host);
  ok('tries again at once with a different password', host.reqs.length === 2);
}
{
  const host = makeHost(() => loginAnswer());
  const result = await plugin.test(passwordCfg({ credential: null }), host);
  ok('asks for the password when only an e-mail is set', !result.success && /no password/.test(result.error) && host.reqs.length === 0);
}
{
  const host = makeHost((url) => (url.endsWith('/eapi/user/login') ? json({ success: 1, user: {} }) : profileAnswer()));
  const result = await plugin.test(passwordCfg(), host);
  ok('fails clearly when a login returns no session', !result.success && /no session/.test(result.error));
}
{
  const host = makeHost((url) =>
    url.endsWith('/eapi/user/login') ? loginAnswer() : json({ success: 1, file: { extension: 'epub', downloadLink: 'https://dl.example/x' } }),
  );
  const file = await plugin.resolveFile({ guid: '129316134-a03568', title: 'Awakened', format: 'epub', sizeBytes: null, seeders: null, leechers: null }, passwordCfg(), host);
  ok('a grab logs in with the password too', file.url === 'https://dl.example/x' && host.reqs[1].init.headers.Cookie === 'remix_userid=777; remix_userkey=feedface0123');
}

console.log('resolveFile');
{
  const host = makeHost(() => json({ success: 1, file: { downloadLink: 'http://dl.example/file' } }));
  const threw = await plugin.resolveFile({ guid: '1-abc', title: 'x', format: 'epub', sizeBytes: null, seeders: null, leechers: null }, cfg(), host).catch((error) => error);
  ok('refuses a download link that is not https', /not https/.test(threw?.message ?? ''), threw?.message);
}
const release = { guid: '129316134-a03568', title: 'Awakened (The Last Daughter Book 2)', format: 'epub', sizeBytes: 1990502, seeders: null, leechers: null };
{
  const host = makeHost(() => json({ success: 1, file: { extension: 'epub', allowDownload: true, downloadLink: 'https://dl.example/file/abc?token=1' } }));
  const file = await plugin.resolveFile(release, cfg(), host);
  ok('asks for the file by id and hash', host.calls[0] === 'https://z-lib.gd/eapi/book/129316134/a03568/file');
  ok('sends the session', /remix_userkey=/.test(host.reqs[0].init.headers.Cookie));
  ok('hands over the download link', file.url === 'https://dl.example/file/abc?token=1');
  ok('names the file after the release', file.fileName === 'Awakened The Last Daughter Book 2.epub' && file.format === 'epub' && file.sizeBytes === 1990502);
}
{
  const host = makeHost(() => json({ success: 1, file: { downloadLink: '/dl/abc' } }));
  const file = await plugin.resolveFile(release, cfg(), host);
  ok('resolves a relative link against the mirror', file.url === 'https://z-lib.gd/dl/abc');
}
{
  const host = makeHost(() => json({ success: 0, error: 'Daily limit reached' }));
  let threw = null;
  try {
    await plugin.resolveFile(release, cfg(), host);
  } catch (error) {
    threw = error;
  }
  ok('reports a spent allowance as throttled, without failing over', threw?.failure === 'throttled' && host.reqs.length === 1, threw?.message);
}
{
  const host = makeHost(() => json({ success: 1, file: { allowDownload: false } }));
  let threw = null;
  try {
    await plugin.resolveFile(release, cfg(), host);
  } catch (error) {
    threw = error;
  }
  ok('says so when a download is not allowed', /not allowed/.test(threw?.message ?? ''));
}
{
  const host = makeHost(() => json({ success: 1 }));
  let threw = null;
  try {
    await plugin.resolveFile({ ...release, guid: 'd0f02803fcd0724c2448d2acc5e0cd1b' }, cfg(), host);
  } catch (error) {
    threw = error;
  }
  ok('refuses a release without a book id', /no Z-Library book id/.test(threw?.message ?? '') && host.reqs.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
