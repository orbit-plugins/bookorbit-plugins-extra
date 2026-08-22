/**
 * Exercises the plugin against the response shapes the tracker documents and returns.
 *
 * Unlike the open-library plugins here, these fixtures are written rather than captured: the
 * tracker is private, every endpoint needs a session, and a saved page would carry an account's
 * identifiers. They follow the shapes the plugin's own comments record, including the two places
 * the tracker's field reference and its worked example disagree.
 *
 * The plugin keeps the live session and the seedbox timer in module-level maps keyed by indexer id,
 * so every block below uses an id of its own. Sharing one would let an earlier rotation decide a
 * later result.
 *
 * Run with: node verify.mjs
 */
import plugin from './index.mjs';

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
  const saved = [];
  const logs = [];
  return {
    reqs,
    saved,
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
    saveCredential: async (value) => saved.push(value),
    fail: (code, message) => Object.assign(new Error(message), { code }),
  };
}

const res = (body, init = {}) => new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
const json = (value, init) => res(JSON.stringify(value), init);
const bencode = (bytes = [0x64, 0x65]) => res(new Uint8Array(bytes));

let nextId = 1000;
const cfg = (over = {}) => ({
  id: nextId++,
  name: 'MyAnonaMouse',
  priority: 1,
  baseUrl: 'https://www.myanonamouse.net',
  credential: 'session-abc',
  allowPrivateAddress: false,
  categories: { ebook: [14], audiobook: [13], comic: [14] },
  seedRatioGoal: null,
  seedTimeMinutes: null,
  settings: null,
  ...over,
});
const query = (over = {}) => ({ title: 'Project Hail Mary', author: 'Andy Weir', isbn13: null, mediaKind: 'ebook', language: null, limit: 30, ...over });

/** The tracker's own worked-example shape: `name` and `filetype`, not `title` and `filetypes`. */
const ROW = {
  id: 481516,
  name: 'Andy Weir - Project Hail Mary [M4B]',
  filetype: 'm4b',
  size: '1.21 GiB',
  seeders: '42',
  leechers: '3',
  numfiles: '1',
  lang_code: 'ENG',
  added: '2024-01-31 07:14:22',
  author_info: '{"1234":"Andy Weir"}',
  free: '0',
  fl_vip: '0',
  personal_freeleech: '0',
};
const MEDIAINFO = JSON.stringify({
  General: { Duration: '16 h 20 min' },
  Audio1: { BitRate: '126k', BitRate_Mode: 'VBR', Channels: '2', SamplingRate: '44.1kHz' },
  menu: { extra: [1, 2, 3, 4, 5] },
});

const search = (host, over = {}, config = cfg()) => plugin.search(query(over), config, host);

console.log('declaration');
ok('needs a session credential', plugin.requiresCredential === true && plugin.credentialKind === 'sessionId');
ok('carries all three media', JSON.stringify(plugin.mediaKinds) === '["ebook","audiobook","comic"]');
ok('joins a swarm and uses categories', plugin.seedsBack === true && plugin.usesCategories === true);
ok('targets the contract this build speaks', plugin.apiVersion === 1);
ok('plugin version', plugin.version === '1.0.0');
ok('offers the seedbox toggle, off by default', plugin.settingsFields?.[0]?.key === 'dynamicSeedbox' && plugin.settingsFields[0].default === false);
// It has no comic category of its own, so comics fall back to the ebook one.
ok('defaults comics to the ebook category', JSON.stringify(plugin.defaultCategories.comic) === JSON.stringify(plugin.defaultCategories.ebook));
ok('grabs a torrent rather than a file', typeof plugin.fetchTorrentFile === 'function' && plugin.resolveFile === undefined);

console.log('search requests');
{
  const host = makeHost(() => json({ data: [ROW] }));
  await search(host);
  const { url, init } = host.reqs[0];
  const body = JSON.parse(init.body);
  ok('posts to the search endpoint', url.endsWith('/tor/js/loadSearchJSONbasic.php') && init.method === 'POST');
  ok('sends the session as a cookie', init.headers.Cookie === 'mam_id=session-abc');
  // A redirect to the login page is what an expired session looks like; following it would turn an
  // authentication failure into a confusing HTML body.
  ok('never follows a redirect', init.redirect === 'manual');
  ok('searches title and author fields', body.tor.srchIn.title === 'true' && body.tor.srchIn.author === 'true');
  ok('sends the configured category for the medium', JSON.stringify(body.tor.main_cat) === '[14]');
  ok('asks for the request limit', body.perpage === 30);
}
{
  const host = makeHost(() => json({ data: [] }));
  await search(host, { mediaKind: 'audiobook' });
  ok('sends the audiobook category for an audiobook', JSON.stringify(JSON.parse(host.reqs[0].init.body).tor.main_cat) === '[13]');
}
{
  const host = makeHost(() => json({ data: [] }));
  await search(host, { title: 'Project Hail Mary (Unabridged)' });
  // A tracker that ANDs its terms answers a decorated title with nothing at all.
  ok('drops the edition qualifier from the search text', JSON.parse(host.reqs[0].init.body).tor.text === 'Project Hail Mary Andy Weir');
}
{
  const config = cfg({ credential: null });
  const err = await search(makeHost(() => json({ data: [] })), {}, config).catch((e) => e);
  ok('refuses to search with no session configured', err.code === 'unauthorized', err.message);
}

console.log('reading a row');
{
  const host = makeHost(() => json({ data: [{ ...ROW, mediainfo: MEDIAINFO }] }));
  const [r] = await search(host);
  ok('reads the id as the guid', r.guid === '481516');
  // The reference documents `title` and `filetypes`; the worked example returns `name` and
  // `filetype`. Reading one side of either pair would drop every row as an empty result.
  ok('accepts the example spelling of the title', r.title === 'Andy Weir - Project Hail Mary [M4B]');
  ok('accepts the example spelling of the format', r.format === 'm4b');
  ok('builds the download link from the id', r.downloadUrl === 'https://www.myanonamouse.net/tor/download.php?tid=481516');
  ok('reads the swarm counts', r.seeders === 42 && r.leechers === 3);
  ok('reads the language', r.language === 'ENG');
  ok('reads the author out of the id-keyed map', r.author === 'Andy Weir');
  ok('reads the file count', r.fileCount === 1);
  // The tracker writes its own timezone with no offset stated.
  ok('reads the added date as an instant', r.publishedAt === '2024-01-31T07:14:22.000Z', r.publishedAt);
}
{
  const host = makeHost(() => json({ data: [{ ...ROW, name: undefined, title: 'Reference Spelling', filetype: undefined, filetypes: 'epub' }] }));
  const [r] = await search(host);
  ok('accepts the reference spelling of the title', r.title === 'Reference Spelling');
  ok('accepts the reference spelling of the format', r.format === 'epub');
}
for (const [name, patch] of [
  ['no id', { id: '' }],
  ['no title at all', { name: undefined, title: undefined }],
]) {
  const host = makeHost(() => json({ data: [{ ...ROW, ...patch }] }));
  ok(`drops a row with ${name}`, (await search(host)).length === 0);
}
{
  const host = makeHost(() => json({ data: [{ ...ROW, author_info: 'not json' }] }));
  const [r] = await search(host);
  ok('leaves the author unstated when its map will not parse', r.author === undefined);
}
{
  const host = makeHost(() => json({ data: [{ ...ROW, author_info: '{"1":"A","2":"B","3":"C","4":"D"}' }] }));
  const [r] = await search(host);
  ok('names at most three authors', r.author === 'A, B, C');
}

console.log('sizes');
for (const [raw, expected] of [
  ['1.21 GiB', Math.round(1.21 * 1024 ** 3)],
  ['700 MB', Math.round(700 * 1024 ** 2)],
  ['512 KiB', 512 * 1024],
  [1234, 1234],
  ['not a size', null],
]) {
  const host = makeHost(() => json({ data: [{ ...ROW, size: raw }] }));
  const [r] = await search(host);
  ok(`reads a size of ${JSON.stringify(raw)}`, r.sizeBytes === expected, r.sizeBytes);
}

{
  // Zero is not the same as unstated. `Number('')` is 0, so a value with no digits in it used to
  // arrive as a stated zero, and a stated zero seeders is a hard filter that drops the release.
  const host = makeHost(() => json({ data: [{ ...ROW, seeders: 'unknown', leechers: 'n/a', numfiles: '' }] }));
  const [r] = await search(host);
  ok('reports an unreadable seeder count as unstated, not as zero', r.seeders === null, r.seeders);
  ok('and the same for leechers', r.leechers === null, r.leechers);
  ok('and leaves an empty file count off entirely', r.fileCount === undefined, r.fileCount);
}

console.log('freeleech and VIP');
// `fl_vip` means freeleech *or* VIP, so a VIP-only torrent sets it while still costing download.
for (const [name, patch, free, vip] of [
  ['a plain torrent is neither', {}, false, false],
  ['free=1 is freeleech', { free: '1' }, true, false],
  ['personal freeleech counts', { personal_freeleech: '1' }, true, false],
  ['fl_vip without free is VIP only', { fl_vip: '1' }, false, true],
  ['fl_vip with free is the freeleech half', { fl_vip: '1', free: '1' }, true, false],
]) {
  const host = makeHost(() => json({ data: [{ ...ROW, ...patch }] }));
  const [r] = await search(host);
  ok(name, r.freeleech === free && r.vipOnly === vip, `freeleech=${r.freeleech} vipOnly=${r.vipOnly}`);
}

console.log('mediainfo');
{
  const host = makeHost(() => json({ data: [{ ...ROW, mediainfo: MEDIAINFO }] }));
  const [r] = await search(host);
  ok('reads a scaled bitrate', r.audio.bitrateKbps === 126);
  ok('reads the bitrate mode verbatim', r.audio.bitrateMode === 'VBR');
  ok('reads the channel count', r.audio.channels === 2);
  ok('reads a scaled sampling rate', r.audio.samplingRateHz === 44100, r.audio.samplingRateHz);
  ok('reads a written duration', r.audio.durationSeconds === 16 * 3600 + 20 * 60);
  ok('counts chapters from the menu', r.audio.chapterCount === 5);
}
{
  const info = JSON.stringify({ Audio1: { BitRate: '1.41 Mbit/s' } });
  const host = makeHost(() => json({ data: [{ ...ROW, mediainfo: info }] }));
  const [r] = await search(host);
  ok('reads a megabit rate', r.audio.bitrateKbps === 1410, r.audio.bitrateKbps);
}
{
  // A tracker scans one file of a multi-file set and reports seventeen seconds for a whole book.
  const info = JSON.stringify({ General: { Duration: '17 s' }, Audio1: { Channels: '2' } });
  const host = makeHost(() => json({ data: [{ ...ROW, mediainfo: info }] }));
  const [r] = await search(host);
  ok('drops an implausibly short duration rather than showing it', r.audio.durationSeconds === null);
  ok('keeps the fields around it', r.audio.channels === 2);
}
for (const [name, raw] of [
  ['no mediainfo at all', undefined],
  ['an empty mediainfo object', '{}'],
  ['mediainfo that will not parse', 'not json'],
  ['mediainfo with nothing usable in it', '{"General":{}}'],
]) {
  const host = makeHost(() => json({ data: [{ ...ROW, mediainfo: raw }] }));
  const [r] = await search(host);
  ok(`states no audio for ${name}`, r.audio === undefined, JSON.stringify(r.audio));
}

console.log('search failures');
{
  // "Nothing returned" is how the tracker says zero results; it is not a failure.
  const out = await search(makeHost(() => json({ error: 'Nothing returned, out of 0' })));
  ok('treats "nothing returned" as no results', out.length === 0);
}
{
  const err = await search(makeHost(() => json({ error: 'Something broke' }))).catch((e) => e);
  ok('reports any other stated error', err.code === 'error' && /Something broke/.test(err.message));
}
{
  const err = await search(makeHost(() => res('', { status: 429 }))).catch((e) => e);
  ok('reports rate limiting as its own failure', err.code === 'throttled');
}
for (const status of [401, 403, 302]) {
  const err = await search(makeHost(() => res('Session ASN mismatch', { status }))).catch((e) => e);
  ok(`reports ${status} as a rejected session`, err.code === 'unauthorized', err.message);
}
{
  // The tracker puts the reason in the body, not the status line, and a bare number is useless.
  const err = await search(makeHost(() => res('<html><style>b{color:red}</style><b>Session ASN mismatch</b></html>', { status: 403 }))).catch((e) => e);
  ok('carries the tracker\'s own words along with the refusal', /Session ASN mismatch/.test(err.message), err.message);
  ok('and leaves the stylesheet out of them', !/color:red/.test(err.message), err.message);
}
{
  const err = await search(makeHost(() => res('x'.repeat(5000), { status: 403 }))).catch((e) => e);
  ok('caps how much of a refusal it repeats', err.message.length < 400, err.message.length);
}
{
  const err = await search(makeHost(() => res('', { status: 500 }))).catch((e) => e);
  ok('reports any other status as an error', err.code === 'error');
}
{
  // An expired session is answered with HTML, so a parse failure is an authentication problem.
  const err = await search(makeHost(() => res('<html>login</html>'))).catch((e) => e);
  ok('reads a login page as an expired session', err.code === 'unauthorized', err.message);
}

console.log('session rotation');
{
  const host = makeHost(() => json({ data: [] }, { headers: [['set-cookie', 'mam_id=rotated-xyz; Path=/; HttpOnly']] }));
  const config = cfg();
  await search(host, {}, config);
  ok('saves a rotated session', host.saved.length === 1 && host.saved[0] === 'rotated-xyz', host.saved);

  // Sent back verbatim on the next call: the value arrives URL-encoded and decoding breaks it.
  const second = makeHost(() => json({ data: [] }));
  await search(second, {}, config);
  ok('uses the rotated session from then on', second.reqs[0].init.headers.Cookie === 'mam_id=rotated-xyz');
}
{
  const host = makeHost(() => json({ data: [] }, { headers: [['set-cookie', 'mam_id=session-abc; Path=/']] }));
  await search(host);
  ok('does not save a session that has not changed', host.saved.length === 0);
}
{
  const host = makeHost(() => json({ data: [] }, { headers: [['set-cookie', 'other=1; Path=/']] }));
  await search(host);
  ok('ignores a cookie that is not the session', host.saved.length === 0);
}
{
  // Captured before the status is judged, so a rotation that arrives on a refusal is not lost.
  const host = makeHost(() => res('nope', { status: 403, headers: [['set-cookie', 'mam_id=rotated-on-refusal; Path=/']] }));
  await search(host).catch(() => {});
  ok('captures a rotation that arrives with a refusal', host.saved[0] === 'rotated-on-refusal', host.saved);
}

console.log('fetchTorrentFile()');
{
  const host = makeHost(() => bencode());
  const out = await plugin.fetchTorrentFile({ guid: '1', title: 't', downloadUrl: 'https://www.myanonamouse.net/tor/download.php?tid=1' }, cfg(), host);
  ok('returns the torrent bytes', out instanceof Uint8Array && out[0] === 0x64);
  ok('fetches it with the session', host.reqs[0].init.headers.Cookie === 'mam_id=session-abc');
}
{
  const err = await plugin.fetchTorrentFile({ guid: '1', title: 't' }, cfg(), makeHost(() => bencode())).catch((e) => e);
  ok('refuses a release with no download link', err.code === 'error', err.message);
}
{
  const err = await plugin.fetchTorrentFile({ downloadUrl: 'https://x/1' }, cfg(), makeHost(() => res(new Uint8Array()))).catch((e) => e);
  ok('refuses an empty torrent', err.code === 'error', err.message);
}
{
  const err = await plugin.fetchTorrentFile({ downloadUrl: 'https://x/1' }, cfg(), makeHost(() => res(new Uint8Array(3 * 1024 * 1024)))).catch((e) => e);
  ok('refuses a torrent too large to be one', err.code === 'error', err.message);
}
{
  // An expired session answers a download link with an HTML login page, not an error status.
  const err = await plugin.fetchTorrentFile({ downloadUrl: 'https://x/1' }, cfg(), makeHost(() => res('<html>login</html>'))).catch((e) => e);
  ok('reads a login page in place of a torrent as an expired session', err.code === 'unauthorized', err.message);
}

console.log('dynamic seedbox');
{
  const host = makeHost(() => bencode());
  await plugin.fetchTorrentFile({ downloadUrl: 'https://x/1' }, cfg(), host);
  ok('is not registered unless asked for', host.calls.every((u) => !u.includes('dynamicSeedbox')));
}
{
  const host = makeHost((url) => (url.includes('dynamicSeedbox') ? json({ Success: true, msg: 'Completed' }) : bencode()));
  await plugin.fetchTorrentFile({ downloadUrl: 'https://x/1' }, cfg({ settings: { dynamicSeedbox: true } }), host);
  // Before the fetch, because the announce follows within seconds of the client getting the file.
  ok('registers the address before fetching the torrent', host.calls[0].includes('dynamicSeedbox'), host.calls);
}
{
  const config = cfg({ settings: { dynamicSeedbox: true } });
  const host = makeHost((url) => (url.includes('dynamicSeedbox') ? json({ Success: true, msg: 'Completed' }) : bencode()));
  await plugin.fetchTorrentFile({ downloadUrl: 'https://x/1' }, config, host);
  await plugin.fetchTorrentFile({ downloadUrl: 'https://x/2' }, config, host);
  // The tracker will not move the registration more than once an hour, so neither does this.
  ok('registers at most once an hour', host.calls.filter((u) => u.includes('dynamicSeedbox')).length === 1);
}
{
  // Overwhelmingly a session created without dynamic-seedbox permission. Never fatal: the grab is
  // left to fail at the tracker with the tracker's own message.
  const host = makeHost((url) => (url.includes('dynamicSeedbox') ? json({ Success: false, msg: 'Not authorized' }) : bencode()));
  const out = await plugin.fetchTorrentFile({ downloadUrl: 'https://x/1' }, cfg({ settings: { dynamicSeedbox: true } }), host).catch((e) => e);
  ok('hands over the torrent even when registration is refused', out instanceof Uint8Array);
  ok('and says so in the log', host.logs.some((m) => /Not authorized/.test(m)), host.logs);
}
{
  const host = makeHost((url) => (url.includes('dynamicSeedbox') ? Promise.reject(new Error('boom')) : bencode()));
  const out = await plugin.fetchTorrentFile({ downloadUrl: 'https://x/1' }, cfg({ settings: { dynamicSeedbox: true } }), host).catch((e) => e);
  ok('hands over the torrent even when registration throws', out instanceof Uint8Array);
}
{
  // "No change" means the registration is already where it should be, not that anything failed.
  const host = makeHost((url) => (url.includes('dynamicSeedbox') ? json({ Success: false, msg: 'No change' }) : bencode()));
  await plugin.fetchTorrentFile({ downloadUrl: 'https://x/1' }, cfg({ settings: { dynamicSeedbox: true } }), host);
  ok('treats "no change" as success', host.logs.some((m) => /seedbox address registered/.test(m)), host.logs);
}

console.log('test() and keepalive()');
{
  const out = await plugin.test(cfg({ credential: null }), makeHost(() => json({})));
  ok('fails before calling anything when no session is set', out.success === false && /mam_id/.test(out.error));
}
{
  const host = makeHost(() => json({ unread: 0 }));
  const out = await plugin.test(cfg(), host);
  ok('passes when the cheap authenticated endpoint answers', out.success === true && out.indexerName === 'MyAnonaMouse');
  ok('and uses that endpoint rather than a search', host.calls[0].includes('/jsonLoad.php'));
}
{
  const out = await plugin.test(cfg(), makeHost(() => res('<html>login</html>')));
  ok('fails rather than throwing on an expired session', out.success === false, out.error);
}
{
  const host = makeHost(() => json({ unread: 0 }));
  await plugin.keepalive(cfg(), host);
  ok('keepalive touches the session', host.calls.some((u) => u.includes('/jsonLoad.php')));
}
{
  const host = makeHost(() => json({ unread: 0 }));
  await plugin.keepalive(cfg({ credential: null }), host);
  ok('keepalive does nothing without a session', host.calls.length === 0);
}
{
  // A home connection's address moves on its own schedule, so it is refreshed on the same tick.
  const host = makeHost((url) => (url.includes('dynamicSeedbox') ? json({ Success: true, msg: 'ok' }) : json({ unread: 0 })));
  await plugin.keepalive(cfg({ settings: { dynamicSeedbox: true } }), host);
  ok('keepalive refreshes the seedbox registration too', host.calls.some((u) => u.includes('dynamicSeedbox')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
