/**
 * MyAnonaMouse as a BookOrbit indexer plugin.
 *
 * This is the thing that used to live in the BookOrbit repository as `mam.adapter.ts`. It is
 * here instead, which is the whole point of the plugin system: source-specific code belongs to
 * whoever runs the source, not to the application.
 *
 * One file, no dependencies, no BookOrbit imports. Everything it needs from the host arrives in
 * `host`, which is also what applies the address policy, the request deadline and the log
 * sanitising it is not trusted to apply itself.
 */

const SEARCH_PATH = '/tor/js/loadSearchJSONbasic.php';
const DOWNLOAD_PATH = '/tor/download.php';
/** The cheapest authenticated endpoint, used only to keep the session from lapsing. */
const KEEPALIVE_PATH = '/jsonLoad.php';
/**
 * Registers the *calling* IP as the account's seedbox address. Being on the session's ASN gets a
 * search and a .torrent download accepted; it does not get an announce accepted, which the tracker
 * checks against this separate registration and otherwise rejects as "Unrecognized host/PassKey".
 */
const SEEDBOX_PATH = '/json/dynamicSeedbox.php';
/** The tracker will not move the registration more than once an hour, so neither do we. */
const SEEDBOX_MIN_INTERVAL_MS = 60 * 60 * 1000;
/** Answers that mean the registration is already where it should be, not that anything failed. */
const SEEDBOX_BENIGN = /no change|too recent/i;

/** A .torrent is a few kilobytes of metadata; anything larger is not one. */
const MAX_TORRENT_FILE_BYTES = 2 * 1024 * 1024;
/** A refusal is a sentence, not a document: enough to read it, little enough to never buffer a page. */
const MAX_REFUSAL_BYTES = 8 * 1024;
const MAX_REFUSAL_CHARS = 200;
/** Anything shorter described one file of a multi-file set, not the release. */
const MIN_PLAUSIBLE_DURATION_SECONDS = 10 * 60;

/** The tracker refuses anything outside this, and a request may ask for fewer than five. */
const MIN_PER_PAGE = 5;
const MAX_PER_PAGE = 1000;

/**
 * The E-Books subcategory that actually holds comics, confirmed against the live category list on
 * 2026-08-20. Sent alongside `main_cat` rather than instead of it: whether `tor.cat` narrows a
 * search was never confirmed, and if the tracker ignores it the search is simply the whole E-Books
 * category it already was.
 */
const COMIC_CATEGORIES = [61];

/**
 * The tracker's own language numbers, harvested on 2026-08-20 by sampling `language`/`lang_code`
 * pairs; they are not in its API reference. Keyed by both the two- and three-letter codes a request
 * might carry, since BookOrbit normalises neither.
 *
 * The map is many-to-one on purpose: Spanish is 4 and 55, Portuguese is 34 and 52, and sending only
 * one of each pair silently halves the results for those languages.
 */
const LANGUAGE_IDS = {
  en: [1], eng: [1],
  zh: [2, 44], chi: [2], yue: [44],
  es: [4, 55], spa: [4, 55],
  th: [7], tha: [7],
  hi: [8], hin: [8],
  mr: [9], mar: [9],
  te: [10], tel: [10],
  ta: [11], tam: [11],
  vi: [13], vie: [13],
  ur: [15], urd: [15],
  ru: [16], rus: [16],
  af: [17], afr: [17],
  bg: [18], bul: [18],
  ca: [19], cat: [19],
  cs: [20], cze: [20], ces: [20],
  da: [21], dan: [21],
  nl: [22], dut: [22], nld: [22],
  fi: [23], fin: [23],
  uk: [25], ukr: [25],
  el: [26], gre: [26], ell: [26],
  he: [27], heb: [27],
  hu: [28], hun: [28],
  tl: [29], tgl: [29],
  ro: [30], rom: [30], ron: [30],
  sr: [31], srp: [31],
  ar: [32], ara: [32],
  pt: [34, 52], por: [34, 52],
  bn: [35], ben: [35],
  fr: [36], fre: [36], fra: [36],
  de: [37], ger: [37], deu: [37],
  ja: [38], jpn: [38],
  fa: [39], fas: [39], per: [39],
  sv: [40], swe: [40],
  ko: [41], kor: [41],
  tr: [42], tur: [42],
  it: [43], ita: [43],
  pl: [45], pol: [45],
  la: [46], lat: [46],
  no: [48], nor: [48],
  hr: [49], hrv: [49],
  lt: [50], lit: [50],
  bs: [51], bos: [51],
  id: [53], ind: [53],
  sl: [54], slv: [54],
  ga: [56], gle: [56],
  ml: [58], mal: [58],
  grc: [59],
  sa: [60], san: [60],
};

/**
 * What the tracker files a release under when nobody said. Sent alongside whatever language was
 * asked for, so an untagged copy of the right book is not excluded by the very filter meant to
 * save result slots.
 */
const UNKNOWN_LANGUAGE_ID = 47;

/** The live session per indexer, which the tracker rotates out from under the stored one. */
const sessions = new Map();
/** When the seedbox registration was last attempted per indexer, to respect the hourly limit. */
const seedboxTouchedAt = new Map();

export default {
  apiVersion: 1,
  version: '1.0.0',
  type: 'myanonamouse',
  label: 'MyAnonaMouse',
  requiresCredential: true,
  credentialKind: 'sessionId',
  mediaKinds: ['ebook', 'audiobook', 'comic'],
  usesCategories: true,
  seedsBack: true,
  defaultBaseUrl: 'https://www.myanonamouse.net',
  baseUrlHint: "The tracker's own address, normally https://www.myanonamouse.net",
  // Its own main category numbers. Comics live inside E-Books rather than in a main category of
  // their own, so the medium keeps 14 here and the search narrows it with `cat` (COMIC_CATEGORIES).
  defaultCategories: { ebook: [14], audiobook: [13], comic: [14] },
  settingsFields: [
    {
      key: 'dynamicSeedbox',
      type: 'boolean',
      label: 'Register this server as the seedbox',
      hint: 'The tracker refuses announces from an address your account has not registered. Turn this on to register the address BookOrbit connects from, which is only correct when your download client shares that address. The session must have been created with dynamic seedbox permission.',
      default: false,
    },
  ],

  async search(query, config, host) {
    const found = await runSearch(query, config, host, false);
    if (found.length > 0) return found;

    /**
     * The tracker is full of series packs whose torrent name is the series and whose individual
     * books are named only in the description body, so a title search finds nothing at all for a
     * book that is definitely there. Broadening costs a second request, and only on a miss, which
     * is exactly when it is worth spending: a successful search is never diluted by it.
     */
    return runSearch(query, config, host, true);
  },

  async test(config, host) {
    if (!config.credential) return { success: false, error: 'MyAnonaMouse needs a mam_id session id before it can be tested' };
    try {
      const response = await call(config, host, `${KEEPALIVE_PATH}?snatch_summary`, { method: 'GET' });
      await readJson(config, host, response);
      return { success: true, indexerName: 'MyAnonaMouse' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      host.logger.warn(`[mam.test] [fail] indexerId=${config.id} error="${message}" - test failed`);
      return { success: false, error: message };
    }
  },

  /**
   * A private tracker's download link is credentialed, so the .torrent is fetched here with the
   * session rather than handed to the download client as a URL it could not authenticate.
   */
  async fetchTorrentFile(release, config, host) {
    if (!release.downloadUrl) throw host.fail('error', 'That release has no download link');

    // Before the fetch rather than after: the announce follows within seconds of the download
    // client being handed the file, and the registration has to already be in place by then.
    await authorizeSeedbox(config, host);

    const response = await fetchWithSession(config, host, release.downloadUrl, { method: 'GET' });
    const body = new Uint8Array(await response.arrayBuffer());

    if (body.byteLength === 0) throw host.fail('error', 'The tracker returned an empty .torrent file');
    if (body.byteLength > MAX_TORRENT_FILE_BYTES) throw host.fail('error', 'The tracker returned a .torrent file that is too large');
    // An expired session answers a download link with an HTML login page, not an error status.
    if (body[0] !== 0x64) {
      throw host.fail('unauthorized', 'the tracker answered the download link with a login page. The session id has expired.');
    }
    return body;
  },

  /**
   * The session lapses on its own clock, and the failure only shows up the next time somebody
   * approves a request. Touching the cheapest authenticated endpoint on a schedule keeps it alive
   * and captures the rotated id while there is still a valid one to rotate from.
   */
  async keepalive(config, host) {
    if (!config.credential) return;
    const response = await call(config, host, `${KEEPALIVE_PATH}?snatch_summary`, { method: 'GET' });
    await readJson(config, host, response);
    // A home connection's address moves on its own schedule, so the registration is refreshed on
    // the same tick rather than only when somebody happens to grab something.
    await authorizeSeedbox(config, host);
  },
};

async function runSearch(query, config, host, broaden) {
  // The host applies its own deadline to every call, so `signal` is not forwarded.
  const response = await call(config, host, SEARCH_PATH, {
    method: 'POST',
    body: JSON.stringify(searchBody(query, config, host, broaden)),
    headers: { 'Content-Type': 'application/json' },
  });

  const payload = await readJson(config, host, response);
  // "Nothing returned" is how the tracker says zero results; it is not a failure.
  if (payload.error && /nothing returned/i.test(payload.error)) return [];
  if (payload.error) throw host.fail('error', payload.error);

  return (payload.data ?? []).map((row) => toRelease(row, config)).filter(Boolean);
}

function searchBody(query, config, host, broaden) {
  const body = {
    tor: {
      text: host.buildSearchText(query),
      srchIn: broaden ? { title: 'true', author: 'true', series: 'true', description: 'true' } : { title: 'true', author: 'true' },
      /**
       * The tracker's own version of the zero-seeder hard filter BookOrbit applies afterwards.
       * Pushing it here stops a dead torrent from spending one of the result slots. `searchType`
       * takes exactly one value, so this and freeleech-only cannot both be on; freeleech stays a
       * scoring bonus and a picker facet instead.
       */
      searchType: 'active',
      searchIn: 'torrents',
      main_cat: config.categories[query.mediaKind],
      /**
       * With text present this is the tracker's own relevance weight. Sorting by seeders instead
       * only decides which fifty rows arrive, and on a prolific author it fills them with the
       * best-seeded wrong books; BookOrbit re-ranks whatever comes back regardless.
       */
      sortType: 'default',
      startNumber: 0,
    },
    // Absent without this. Coverage measured at four rows in six on 2026-08-20, and the field is
    // not always an ISBN - `ASIN:B08G9PRS1K` appears in it - which BookOrbit's normalisation drops.
    isbn: true,
    perpage: Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, query.limit)),
  };

  if (query.mediaKind === 'comic') body.tor.cat = COMIC_CATEGORIES;

  const languages = browseLanguages(query.language);
  if (languages) body.tor.browse_lang = languages;

  return body;
}

/** Null where the language is unmapped, which leaves the filter off rather than guessing an id. */
function browseLanguages(language) {
  if (!language) return null;
  const ids = LANGUAGE_IDS[language.trim().toLowerCase()];
  return ids ? [...ids, UNKNOWN_LANGUAGE_ID] : null;
}

function call(config, host, path, init) {
  if (!config.credential) throw host.fail('unauthorized', 'no session id is configured');
  const base = config.baseUrl.replace(/\/+$/, '');
  return fetchWithSession(config, host, `${base}${path}`, init);
}

async function fetchWithSession(config, host, url, init) {
  const session = sessions.get(config.id) ?? config.credential ?? '';

  const response = await host.fetch(url, {
    ...init,
    // Manual, because a redirect to the login page is what an expired session looks like and
    // following it would turn an authentication failure into a confusing HTML body.
    redirect: 'manual',
    headers: { ...(init.headers ?? {}), Cookie: `mam_id=${session}` },
  });

  await captureRotatedSession(config, host, response);

  if (response.status === 429) throw host.fail('throttled', 'the tracker is rate limiting us');
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw host.fail('unauthorized', `the session id was rejected. It is ASN locked and may need to be reissued.${await readRefusal(response)}`);
  }
  if (!response.ok) throw host.fail('error', `the tracker answered ${response.status}${await readRefusal(response)}`);
  return response;
}

/** The tracker reissues `mam_id` as it pleases; the new one has to outlive this process. */
async function captureRotatedSession(config, host, response) {
  const rotated = extractCookie(response, 'mam_id');
  if (!rotated || rotated === (sessions.get(config.id) ?? config.credential)) return;
  sessions.set(config.id, rotated);
  await host.saveCredential(rotated);
}

/**
 * Registers this server's egress IP as the account's seedbox address, which is what the tracker
 * checks on announce. Opt-in because it registers *our* address: where the download client seeds
 * from somewhere else, calling this would register the wrong one and break the very announces it
 * is meant to fix.
 *
 * Never throws. A registration that did not go through leaves the grab to fail at the tracker with
 * the tracker's own message, which is more useful than refusing to hand over the torrent.
 */
async function authorizeSeedbox(config, host) {
  if (config.settings?.dynamicSeedbox !== true) return;

  const last = seedboxTouchedAt.get(config.id);
  if (last !== undefined && Date.now() - last < SEEDBOX_MIN_INTERVAL_MS) return;

  try {
    const response = await call(config, host, SEEDBOX_PATH, { method: 'GET' });
    // Stamped on an answer rather than on an attempt: a call that never reached the tracker has
    // not used up the hour, and holding the next grab off for one would be the wrong trade.
    seedboxTouchedAt.set(config.id, Date.now());
    const payload = await readJson(config, host, response);
    const ok = payload.Success ?? payload.success ?? false;
    const message = payload.msg ?? payload.message ?? '';

    if (ok || SEEDBOX_BENIGN.test(message)) {
      host.logger.log(`[mam.seedbox] [end] indexerId=${config.id} result="${message}" - seedbox address registered`);
      return;
    }
    // Overwhelmingly this is a session created without "Allow Session to set Dynamic Seedbox",
    // which the tracker reports as a plain refusal rather than an authentication failure.
    host.logger.warn(`[mam.seedbox] [fail] indexerId=${config.id} result="${message}" - the tracker refused the registration`);
  } catch (error) {
    host.logger.warn(`[mam.seedbox] [fail] indexerId=${config.id} error="${error instanceof Error ? error.message : String(error)}"`);
  }
}

/**
 * An expired session is answered with HTML, so a parse failure is an authentication problem rather
 * than a malformed response. Saying so is the whole point of this adapter.
 */
async function readJson(config, host, response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw host.fail('unauthorized', 'the tracker answered with a login page rather than data. The session id has expired.');
  }
}

/**
 * The tracker puts the reason in the body and not in the status line: a 403 reads "Session ASN
 * mismatch", and the other codes are just as specific. A bare status number leaves the operator
 * with nothing to act on, so a short flattened excerpt of the tracker's own words rides along.
 */
async function readRefusal(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < MAX_REFUSAL_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder()
    .decode(merged)
    // Contents and all: the tracker's error page carries a <style> block, and stripping only the
    // tags around it would put a stylesheet in front of the one sentence that explains the refusal.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? `: ${text.slice(0, MAX_REFUSAL_CHARS)}` : '';
}

function extractCookie(response, name) {
  const all = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const header of all) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header);
    // Sent back verbatim: the rotated value arrives URL-encoded and decoding it breaks the session.
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * The tracker's field reference and its own worked example disagree on two names: the reference
 * documents `title` and `filetypes`, the example returns `name` and `filetype`. Reading only one
 * side of either pair would drop every row on the floor as an empty result rather than an error.
 */
function toRelease(row, config) {
  const title = (row.title ?? row.name)?.trim();
  const id = row.id === undefined || row.id === null || row.id === '' ? null : String(row.id);
  if (!title || id === null) return null;

  const downloadUrl = new URL(config.baseUrl.replace(/\/+$/, '') + DOWNLOAD_PATH);
  downloadUrl.searchParams.set('tid', id);

  const format = (row.filetype ?? row.filetypes)?.trim().toLowerCase();
  const author = readAuthor(row.author_info);
  const fileCount = toNumber(row.numfiles);
  const publishedAt = parseAdded(row.added);
  const audio = readAudio(row.mediainfo);

  return {
    guid: id,
    title,
    downloadUrl: downloadUrl.href,
    sizeBytes: parseSize(row.size),
    seeders: toNumber(row.seeders),
    leechers: toNumber(row.leechers),
    ...(format ? { format } : {}),
    ...(row.lang_code ? { language: row.lang_code } : {}),
    ...(author ? { author } : {}),
    ...(typeof row.isbn === 'string' && row.isbn.trim() ? { isbn: row.isbn.trim() } : {}),
    // The tracker states a delay of five to twenty minutes on this, so it marks a row in the
    // picker and is never filtered on.
    alreadyGrabbed: isTruthyFlag(row.my_snatched),
    // `fl_vip` is deliberately not consulted here: the tracker defines it as freeleech *or* VIP, so
    // a VIP-only torrent sets it while still costing download for anyone who is not a VIP member.
    freeleech: isTruthyFlag(row.free) || isTruthyFlag(row.personal_freeleech),
    // Which is also what makes the pair readable the other way round. `fl_vip` without `free` can
    // only be the VIP half, and the tracker refuses that download with "you are not VIP or higher"
    // rather than letting it through, so the picker says so before the approver spends a grab.
    vipOnly: isTruthyFlag(row.fl_vip) && !isTruthyFlag(row.free),
    ...(publishedAt ? { publishedAt } : {}),
    ...(audio ? { audio } : {}),
    ...(fileCount !== null ? { fileCount } : {}),
  };
}

/**
 * The tracker carries MediaInfo output for a release whose uploader ran it, which is the only
 * place bitrate and channel count are stated: the file type says "m4b" whether it is 87k mono or
 * 126k stereo. Coverage is partial, so every field degrades to null on its own.
 */
function readAudio(raw) {
  if (!raw || raw === '{}') return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const track = parsed.Audio1 ?? {};
  const duration = parseDuration(parsed.General?.Duration);
  const audio = {
    // "126k" and "1.41 Mbit/s" both appear; anything else is left unstated rather than guessed.
    bitrateKbps: parseRate(track.BitRate, 1000),
    bitrateMode: typeof track.BitRate_Mode === 'string' && track.BitRate_Mode.trim() ? track.BitRate_Mode.trim() : null,
    channels: toNumber(track.Channels),
    samplingRateHz: parseRate(track.SamplingRate, 1),
    // A tracker scans one file of a multi-file set and reports seventeen seconds for a sixteen-hour
    // book, so an implausible figure is dropped rather than shown.
    durationSeconds: duration !== null && duration >= MIN_PLAUSIBLE_DURATION_SECONDS ? duration : null,
    chapterCount: Array.isArray(parsed.menu?.extra) ? parsed.menu.extra.length : null,
  };
  return Object.values(audio).some((value) => value !== null) ? audio : null;
}

/** MediaInfo writes a scaled rate: "126k", "44.1kHz", "1.41 Mbit/s". Returns it in `unit` units. */
function parseRate(value, unit) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value / unit) : null;
  if (typeof value !== 'string') return null;
  const match = /([\d.]+)\s*([kKmM])?/.exec(value.replace(/\s+/g, ' '));
  if (!match) return null;
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1000 : 1;
  const scaled = Number(match[1]) * scale;
  return Number.isFinite(scaled) ? Math.round(scaled / unit) : null;
}

function parseDuration(value) {
  if (typeof value !== 'string') return null;
  let seconds = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+)\s*(h|min|mn|s)\b/gi)) {
    const scale = /^h/i.test(unit) ? 3600 : /^s/i.test(unit) ? 1 : 60;
    seconds += Number(amount) * scale;
  }
  return seconds > 0 ? seconds : null;
}

/** The tracker states an author map keyed by its own author ids. */
function readAuthor(raw) {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    const names = Object.values(parsed).filter((name) => typeof name === 'string' && name.trim());
    return names.length > 0 ? names.slice(0, 3).join(', ') : undefined;
  } catch {
    return undefined;
  }
}

function parseSize(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /([\d.]+)\s*([KMGT]?i?B)/i.exec(value);
  if (!match) return toNumber(value);
  const units = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3, tb: 1024 ** 4, tib: 1024 ** 4 };
  const scale = units[match[2].toLowerCase()] ?? 1;
  const bytes = Number(match[1]) * scale;
  return Number.isFinite(bytes) ? Math.round(bytes) : null;
}

/** The tracker writes "2024-01-31 07:14:22" in its own timezone, with no offset stated. */
function parseAdded(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = new Date(value.replace(' ', 'T') + 'Z');
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function isTruthyFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
  return false;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  // A value with no digits in it strips to an empty string, and `Number('')` is 0. Zero is not the
  // same as unstated, and the difference is load bearing: a stated zero seeders is a hard filter
  // that drops the release outright, and a size of zero fails the size band the same way.
  const digits = String(value).replace(/[^\d.-]/g, '');
  if (digits === '') return null;

  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : null;
}
