/**
 * Z-Library as a BookOrbit indexer plugin.
 *
 * One file, no dependencies, no BookOrbit imports. Everything it needs from the host arrives in
 * `host`, which is also what applies the address policy, the request deadline and the log
 * sanitising it is not trusted to apply itself.
 *
 * Talks to the JSON API the site's own apps use (`/eapi`) rather than scraping pages: the pages sit
 * behind a browser check and the API does not. Searching needs no account; a download does, and is
 * counted against that account's daily allowance. The account is either an e-mail and password,
 * logged in once and the session kept in memory, or the session cookies themselves.
 *
 * The site moves between domains. The main domains answer scripts with a cookie wall, which this
 * does not try to get past: it uses the mirrors that serve the API openly, fails over between them,
 * and learns new ones from the site's own domain list. See `candidateOrigins`. A listed domain is
 * only ever searched anonymously: the account goes nowhere the operator did not configure.
 */

const SEARCH_PATH = '/eapi/book/search';
const PROFILE_PATH = '/eapi/user/profile';
const LOGIN_PATH = '/eapi/user/login';
const DOMAINS_PATH = '/eapi/info/domains';
const filePath = (id, hash) => `/eapi/book/${id}/${hash}/file`;

/**
 * Mirrors that served the API to a plain client when checked on 2026-10-19. Only a starting point:
 * the settings field overrides it, and `/eapi/info/domains` extends it at runtime.
 */
const KNOWN_MIRRORS = ['https://z-lib.gd', 'https://z-lib.gl', 'https://z-lib.by', 'https://z-library.website', 'https://zlib.bz', 'https://z-library.qa'];

/**
 * The self-imposed ceiling on one search, against the 20 seconds the host allows an indexer. Failing
 * over spends it, and being cut off by the host loses the answer a later mirror might have given.
 */
const SEARCH_BUDGET_MS = 15_000;

/** The API answers 200 rows in about a second, so one page of what a request wants is enough. */
const MAX_PAGE_SIZE = 100;
/** How much of one search the exact ISBN pass may fill before the text pass gets the rest. */
const ISBN_PASS_SHARE = 0.5;

const MAX_REFUSAL_CHARS = 200;

/** How long a refused password is left alone, so a typo cannot hammer the login into a lockout. */
const LOGIN_COOLDOWN_MS = 15 * 60 * 1000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const DEFAULT_EBOOK_FORMATS = 'epub,mobi,azw,azw3,fb2,djvu';

/** Only formats BookOrbit accepts for the medium; anything else would be filtered out later. */
const ALLOWED_FORMATS = {
  ebook: ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu'],
};

/** How the site spells a language, which is also what its language filter takes, lowercased. */
const LANGUAGE_BY_NAME = {
  arabic: 'ar',
  bengali: 'bn',
  bulgarian: 'bg',
  catalan: 'ca',
  chinese: 'zh',
  croatian: 'hr',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  estonian: 'et',
  finnish: 'fi',
  french: 'fr',
  german: 'de',
  greek: 'el',
  hebrew: 'he',
  hindi: 'hi',
  hungarian: 'hu',
  icelandic: 'is',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  latin: 'la',
  latvian: 'lv',
  lithuanian: 'lt',
  norwegian: 'no',
  persian: 'fa',
  polish: 'pl',
  portuguese: 'pt',
  romanian: 'ro',
  russian: 'ru',
  serbian: 'sr',
  slovak: 'sk',
  slovenian: 'sl',
  spanish: 'es',
  swedish: 'sv',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
  vietnamese: 'vi',
};
const NAME_BY_LANGUAGE = Object.fromEntries(Object.entries(LANGUAGE_BY_NAME).map(([name, code]) => [code, name]));

/** Copied from the host's `release-scoring.ts` so that a request's language reads the same here. */
const ISO_639_2_TO_1 = {
  alb: 'sq', sqi: 'sq', ara: 'ar', arm: 'hy', hye: 'hy', baq: 'eu', eus: 'eu', ben: 'bn', bul: 'bg',
  bur: 'my', mya: 'my', cat: 'ca', chi: 'zh', zho: 'zh', cze: 'cs', ces: 'cs', dan: 'da', dut: 'nl',
  nld: 'nl', est: 'et', fin: 'fi', geo: 'ka', kat: 'ka', ger: 'de', deu: 'de', gre: 'el', ell: 'el',
  heb: 'he', hin: 'hi', hrv: 'hr', hun: 'hu', ice: 'is', isl: 'is', ind: 'id', ita: 'it', jpn: 'ja',
  kor: 'ko', lav: 'lv', lit: 'lt', mac: 'mk', mkd: 'mk', mao: 'mi', mri: 'mi', may: 'ms', msa: 'ms',
  nor: 'no', per: 'fa', fas: 'fa', pol: 'pl', por: 'pt', rum: 'ro', ron: 'ro', rus: 'ru', slo: 'sk',
  slk: 'sk', slv: 'sl', spa: 'es', srp: 'sr', swe: 'sv', tha: 'th', tib: 'bo', bod: 'bo', tur: 'tr',
  ukr: 'uk', wel: 'cy', cym: 'cy',
};

/** The mirror that last answered, per indexer, so the next call does not start with a dead one. */
const workingOrigin = new Map();
/** Origins a mirror listed, per indexer, so one indexer's mirror cannot steer another's searches. */
const discovered = new Map();
/** The session a password login produced, per indexer. In memory only, so the password stays the one stored secret. */
const logins = new Map();

export default {
  apiVersion: 1,
  version: '1.0.0',
  update: {
    manifestUrl: 'https://raw.githubusercontent.com/orbit-plugins/bookorbit-plugins-extra/main/updates/zlibrary.json',
    ed25519PublicKey: 'W2ER7l0MxMLSxNvfpF5uNg421kAuGxlwlkyFUcpzHrk',
  },
  type: 'zlibrary',
  label: 'Z-Library',
  requiresCredential: true,
  credentialKind: 'sessionId',
  mediaKinds: ['ebook'],
  supportsIsbnSearch: true,
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: KNOWN_MIRRORS[0],
  baseUrlHint: 'The mirror to try first. Others from the mirror list are tried when it stops answering.',
  settingsFields: [
    {
      key: 'ebookFormats',
      type: 'string',
      label: 'Ebook formats',
      hint: 'Sent to the site as a filter, so other formats never take up a result slot.',
      default: DEFAULT_EBOOK_FORMATS,
      format: 'list',
      options: ALLOWED_FORMATS.ebook,
      minItems: 1,
    },
    {
      key: 'email',
      type: 'string',
      label: 'Z-Library e-mail',
      hint: 'Log in with this account, its password in the Session ID field. Leave empty to enter remix_userid:remix_userkey there instead.',
    },
    {
      key: 'mirrors',
      type: 'string',
      label: 'Fallback mirrors',
      hint: 'Tried in order after the base URL. Domains the site itself lists are added after these.',
      default: KNOWN_MIRRORS.join(','),
      format: 'list',
    },
  ],

  /** The ISBN first when the request states one, then title and author, deduplicated by book. */
  async search(query, config, host, signal) {
    if (query.mediaKind !== 'ebook') throw host.fail('unsupportedMedium', `does not carry ${query.mediaKind} releases`);
    const formats = configuredFormats(config);
    if (formats.length === 0) throw host.fail('unsupportedMedium', 'no ebook formats are configured for this indexer');

    const started = Date.now();
    const releases = [];
    const seen = new Set();
    const passes = [];
    // The site matches an ISBN against every edition that states it, which includes translations
    // filed under the original's ISBN, so this pass only leads and never fills the whole limit.
    if (/^\d{13}$/.test(query.isbn13 ?? '')) {
      passes.push({ text: query.isbn13, cap: Math.max(1, Math.floor(query.limit * ISBN_PASS_SHARE)) });
    }
    passes.push({ text: host.buildSearchText(query), cap: query.limit });

    let failure = null;
    for (const pass of passes) {
      if (releases.length >= query.limit || signal?.aborted) break;
      try {
        const payload = await apiCall(config, host, SEARCH_PATH, { method: 'POST', body: searchBody(pass.text, query, formats) }, signal, started);
        for (const book of payload.books ?? []) {
          const release = toRelease(book, formats);
          if (!release || seen.has(release.guid)) continue;
          seen.add(release.guid);
          releases.push(release);
          if (releases.length >= pass.cap) break;
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure && releases.length === 0) throw failure;

    host.logger.log(
      `[zlibrary.search] [end] indexerId=${config.id} language=${query.language ?? 'any'} found=${releases.length} ` +
        `durationMs=${Date.now() - started} - search finished`,
    );
    return releases;
  },

  async test(config, host) {
    try {
      const payload = await accountCall(config, host, PROFILE_PATH);
      const user = payload.user ?? {};
      const limit = toNumber(user.downloads_limit);
      const today = toNumber(user.downloads_today);
      const allowance = limit !== null && today !== null ? ` (${Math.max(0, limit - today)} of ${limit} downloads left today)` : '';
      const email = emailOf(config);
      return { success: true, indexerName: `Z-Library${email ? ` (${email})` : ''}${allowance}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      host.logger.warn(`[zlibrary.test] [fail] indexerId=${config.id} error="${message}" - test failed`);
      return { success: false, error: message };
    }
  },

  /**
   * Asks the API for a download link, which spends one of the account's daily downloads, so it is
   * only called once an approver has picked the release.
   */
  async resolveFile(release, config, host, signal) {
    const book = bookOf(release);
    if (!book) throw host.fail('error', 'that release carries no Z-Library book id, so there is nothing to look up');

    const payload = await accountCall(config, host, filePath(book.id, book.hash), signal);
    const file = payload.file ?? {};
    if (typeof file.downloadLink !== 'string' || !file.downloadLink) {
      throw host.fail('error', `the site gave no download link${file.allowDownload === false ? ': downloading this book is not allowed' : ''}`);
    }

    const format = (release.format ?? file.extension ?? '').toLowerCase();
    if (!format) throw host.fail('error', `"${release.title}" states no format, so there is no way to name the file it would be saved as`);

    let url;
    try {
      url = new URL(file.downloadLink, workingOrigin.get(config.id) ?? baseOf(config));
    } catch {
      throw host.fail('error', 'the site gave a download link that is not a URL');
    }
    if (url.protocol !== 'https:') throw host.fail('error', `the site gave a download link over ${url.protocol.replace(':', '')}, not https`);

    host.logger.log(`[zlibrary.resolve] [end] indexerId=${config.id} book=${book.id} host=${url.host} - download link resolved`);
    return {
      url: url.href,
      fileName: `${sanitizeName(release.title)}.${format}`,
      sizeBytes: release.sizeBytes ?? null,
      format,
    };
  },

  /** Called every six hours. There is no session to keep alive, but the domain list goes stale. */
  async keepalive(config, host) {
    await refreshDomains(config, host);
  },
};

/**
 * Every origin worth trying, best first: the one that last answered, the configured base URL, the
 * configured mirrors, then whatever the site's own domain list added.
 *
 * A call that carries the account never reaches a listed domain. The list arrives from a mirror,
 * and a mirror that lied about it would otherwise be handed the password or the session.
 */
function candidateOrigins(config, withAccount) {
  const configured = uniqueOrigins([
    baseOf(config),
    ...splitList(typeof config.settings?.mirrors === 'string' ? config.settings.mirrors : KNOWN_MIRRORS.join(',')),
  ]);
  const working = workingOrigin.get(config.id);
  if (withAccount) return uniqueOrigins([configured.includes(working) ? working : null, ...configured]);
  return uniqueOrigins([working, ...configured, ...(discovered.get(config.id) ?? [])]);
}

function uniqueOrigins(values) {
  const origins = [];
  for (const value of values) {
    const origin = originOf(value);
    if (origin && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * One API call, failed over across mirrors. A mirror is skipped when it cannot be reached or answers
 * with anything but the API: a redirect, a server error, or a page instead of JSON. Those are what a
 * dead, seized or walled domain looks like.
 *
 * An answer the API itself gives is final whichever mirror gave it. A rejected session or a spent
 * daily allowance belongs to the account, and would be the same on every other mirror.
 */
async function apiCall(config, host, path, { method, body, session, withAccount = Boolean(session) }, signal, started = Date.now()) {
  const skipped = [];
  for (const origin of candidateOrigins(config, withAccount)) {
    if (signal?.aborted) break;
    if (skipped.length > 0 && Date.now() - started > SEARCH_BUDGET_MS) break;

    let response;
    try {
      response = await host.fetch(`${origin}${path}`, {
        method,
        // Manual, because the main domains answer with a redirect into a cookie wall and that is a
        // reason to move on, not something to follow.
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(session ? { Cookie: session } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
    } catch (error) {
      const failure = error?.failure ?? error?.code;
      if (failure !== 'unreachable' && failure !== 'timeout') throw error;
      skipped.push(`${hostOf(origin)} ${failure}`);
      continue;
    }

    if (response.status === 429) throw host.fail('throttled', 'the site is rate limiting us');

    const text = await response.text();
    const payload = parseJson(text);
    if (!payload) {
      skipped.push(`${hostOf(origin)} answered ${response.status} without the API`);
      continue;
    }

    rememberOrigin(config, host, origin);
    if (payload.success) return payload;
    throw refusal(host, response.status, payload);
  }

  throw host.fail(
    'unreachable',
    `no Z-Library mirror answered (${skipped.join('; ') || 'none tried'}). Add a working mirror under Fallback mirrors.`,
  );
}

function rememberOrigin(config, host, origin) {
  if (workingOrigin.get(config.id) === origin) return;
  workingOrigin.set(config.id, origin);
  host.logger.log(`[zlibrary.mirror] [end] indexerId=${config.id} host=${hostOf(origin)} - using this mirror`);
}

/**
 * The domains the site lists for its own apps. Most of them are the walled main domains, which the
 * failover rejects in a single fast round trip; the rest are new mirrors nobody had to add by hand.
 */
async function refreshDomains(config, host) {
  const payload = await apiCall(config, host, DOMAINS_PATH, { method: 'GET' });
  const origins = (payload.domains ?? [])
    .filter((entry) => entry && typeof entry.domain === 'string' && entry.isRedirector !== true && entry.contentAvailable !== false)
    .map((entry) => originOf(entry.domain))
    .filter(Boolean);
  discovered.set(config.id, origins);
  host.logger.log(`[zlibrary.mirror] [end] indexerId=${config.id} listed=${origins.length} - domain list refreshed`);
}

/** The API says why in `error`, with a 200 or a 400 status that carries no meaning of its own. */
function refusal(host, status, payload) {
  const message = typeof payload.error === 'string' && payload.error.trim() ? payload.error.trim().slice(0, MAX_REFUSAL_CHARS) : `the site answered ${status}`;
  if (/log ?in|auth|credential|password|session|user ?key/i.test(message)) {
    return host.fail('unauthorized', `the site rejected the session (${message})`);
  }
  if (/limit|too many|quota/i.test(message)) return host.fail('throttled', message);
  return host.fail('error', message);
}

function searchBody(text, query, formats) {
  const body = new URLSearchParams();
  body.set('message', text);
  body.set('limit', String(Math.min(MAX_PAGE_SIZE, Math.max(1, query.limit))));
  for (const format of formats) body.append('extensions[]', format);
  const language = query.language ? NAME_BY_LANGUAGE[normalizeLanguage(query.language)] : null;
  if (language) body.append('languages[]', language);
  return body.toString();
}

function toRelease(book, formats) {
  if (!book || book.deleted === 1 || book.deleted === '1') return null;
  const id = toNumber(book.id);
  const hash = typeof book.hash === 'string' ? book.hash.trim() : '';
  const title = typeof book.title === 'string' ? book.title.trim() : '';
  const format = typeof book.extension === 'string' ? book.extension.trim().toLowerCase() : '';
  if (id === null || !/^[a-z0-9]+$/i.test(hash) || !title || !formats.includes(format)) return null;

  const author = typeof book.author === 'string' ? book.author.trim() : '';
  const language = typeof book.language === 'string' ? LANGUAGE_BY_NAME[book.language.trim().toLowerCase()] : undefined;
  const isbn = identifiers(book.identifier);
  const bookTitle = bareTitle(title);

  return {
    guid: `${id}-${hash}`,
    title,
    ...(bookTitle ? { bookTitle } : {}),
    sizeBytes: toNumber(book.filesize),
    // Not zero. Nothing here publishes swarm counts, and a zero would be read as a dead torrent.
    seeders: null,
    leechers: null,
    format,
    ...(language ? { language } : {}),
    ...(author ? { author } : {}),
    ...(isbn ? { isbn } : {}),
    primaryFileCount: 1,
  };
}

/** Series and volume ride along in brackets, as in "Awakened (The Last Daughter Book 2)". */
function bareTitle(title) {
  const bare = title.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim();
  return bare && bare !== title ? bare : '';
}

/** Comma separated, ISBN-10 and ISBN-13 of the same edition side by side. */
function identifiers(value) {
  if (typeof value !== 'string') return '';
  return value
    .split(/[;,]/)
    .map((entry) => entry.replace(/[^0-9Xx]/g, '').toUpperCase())
    .filter((entry, index, all) => (entry.length === 10 || entry.length === 13) && all.indexOf(entry) === index)
    .join('; ');
}

function bookOf(release) {
  const match = /^(\d+)-([a-z0-9]+)$/i.exec(typeof release.guid === 'string' ? release.guid.trim() : '');
  return match ? { id: match[1], hash: match[2] } : null;
}

/**
 * An authenticated GET. With a password, a session the site rejects is replaced by one fresh login
 * and the call retried once; a second rejection is the password's, not the session's.
 */
async function accountCall(config, host, path, signal) {
  const email = emailOf(config);
  if (!email) {
    const session = cookieSession(config, host);
    try {
      return await apiCall(config, host, path, { method: 'GET', session }, signal);
    } catch (error) {
      if (error?.failure === 'unauthorized') throw host.fail('unauthorized', `${error.message}. Check remix_userid and remix_userkey.`);
      throw error;
    }
  }

  const cached = logins.get(config.id);
  const fresh = cached?.email === email && cached.password === config.credential && cached.session;
  const session = fresh ? cached.session : await login(config, host, email, signal);
  try {
    return await apiCall(config, host, path, { method: 'GET', session }, signal);
  } catch (error) {
    if (error?.failure !== 'unauthorized' || !fresh) throw error;
    host.logger.warn(`[zlibrary.login] [retry] indexerId=${config.id} - the site rejected the saved session, logging in again`);
    return apiCall(config, host, path, { method: 'GET', session: await login(config, host, email, signal) }, signal);
  }
}

async function login(config, host, email, signal) {
  const password = config.credential ?? '';
  if (!password) throw host.fail('unauthorized', 'no password is configured. Enter the Z-Library password in the Session ID field.');

  const previous = logins.get(config.id);
  if (previous?.email === email && previous.password === password && Date.now() < previous.refusedUntil) {
    throw host.fail('unauthorized', `${previous.refusal} Not retried until ${new Date(previous.refusedUntil).toISOString()}.`);
  }

  const body = new URLSearchParams({ email, password }).toString();
  let payload;
  try {
    payload = await apiCall(config, host, LOGIN_PATH, { method: 'POST', body, withAccount: true }, signal);
  } catch (error) {
    if (error?.failure !== 'unauthorized') throw error;
    const refusal = `the site refused the login (${error.message.replace(/^.*?\((.*)\)$/, '$1')}). Check the e-mail and password.`;
    logins.set(config.id, { email, password, session: null, refusedUntil: Date.now() + LOGIN_COOLDOWN_MS, refusal });
    throw host.fail('unauthorized', refusal);
  }

  const id = payload.user?.id;
  const key = payload.user?.remix_userkey;
  if (!/^\d+$/.test(String(id ?? '')) || !/^[A-Za-z0-9]+$/.test(String(key ?? ''))) {
    throw host.fail('error', 'the site accepted the login but returned no session');
  }
  const session = `remix_userid=${id}; remix_userkey=${key}`;
  logins.set(config.id, { email, password, session, refusedUntil: 0, refusal: '' });
  host.logger.log(`[zlibrary.login] [end] indexerId=${config.id} - logged in`);
  return session;
}

function emailOf(config) {
  const email = config.settings?.email;
  return typeof email === 'string' ? email.trim() : '';
}

/**
 * The account's two cookies, used when no e-mail is set. Taken as `userid:userkey`, or as the
 * cookie pair pasted straight from a browser, because that is where most people will find them.
 */
function cookieSession(config, host) {
  const raw = (config.credential ?? '').trim();
  if (!raw) throw host.fail('unauthorized', 'no session is configured. Set the e-mail and enter the password, or enter remix_userid:remix_userkey.');

  const fromCookies = {
    id: /remix_userid=([^;\s]+)/.exec(raw)?.[1],
    key: /remix_userkey=([^;\s]+)/.exec(raw)?.[1],
  };
  const [id, key] = fromCookies.id && fromCookies.key ? [fromCookies.id, fromCookies.key] : raw.split(/[:\s]+/);
  if (!/^\d+$/.test(id ?? '') || !/^[A-Za-z0-9]+$/.test(key ?? '')) {
    throw host.fail('unauthorized', 'the session should read remix_userid:remix_userkey, a number and a key. To log in with a password instead, set the e-mail.');
  }
  return `remix_userid=${id}; remix_userkey=${key}`;
}

function configuredFormats(config) {
  const raw = config.settings?.ebookFormats;
  return splitList(typeof raw === 'string' && raw.trim() ? raw : DEFAULT_EBOOK_FORMATS)
    .map((format) => format.toLowerCase().replace(/^\./, ''))
    .filter((format, index, all) => ALLOWED_FORMATS.ebook.includes(format) && all.indexOf(format) === index);
}

/** Compares only the language subtag, so "en" and "eng" and "en-GB" all agree. */
function normalizeLanguage(value) {
  const subtag = value.toLowerCase().split(/[-_]/)[0];
  return ISO_639_2_TO_1[subtag] ?? subtag.slice(0, 2);
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && 'success' in value ? value : null;
  } catch {
    return null;
  }
}

function splitList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function baseOf(config) {
  return (config.baseUrl ?? '').replace(/\/+$/, '');
}

/** An origin from a full URL or a bare domain, and only over HTTPS. */
function originOf(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeName(title) {
  return (
    title
      .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'book'
  );
}
