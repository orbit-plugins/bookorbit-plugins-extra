/**
 * Library Genesis as a BookOrbit indexer plugin.
 *
 * A sibling of the other plugins in this folder, and here for the same reason: code that knows
 * about one particular source belongs to whoever runs that source, not to BookOrbit.
 *
 * One file, no dependencies, no BookOrbit imports. Everything it needs from the host arrives in
 * `host`, which is also what applies the address policy, the request deadline and the log
 * sanitising it is not trusted to apply itself.
 *
 * Not a tracker. It serves the file itself, so this declares `resolveFile` rather than
 * `fetchTorrentFile`, reports no swarm counts at all, and needs an HTTP download client rather
 * than a torrent one.
 *
 * A grab is two steps, both cheap and both plain HTTP: the search row carries an md5, and
 * `/ads.php?md5=` answers with a short-lived keyed `get.php` link that redirects to whichever host
 * actually holds the file. Measured 2026-08-20 against libgen.li: a scoped search is 1.3s to 3.1s,
 * and the download link resolves in under a second.
 */

const SEARCH_PATH = '/index.php';
const ADS_PATH = '/ads.php';
const GET_PATH = '/get.php';

/** A full result page of markup, with room to spare. Nothing is buffered past this. */
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
/** One intermediate page, which exists only to carry a single link out of it. */
const MAX_PAGE_BYTES = 1024 * 1024;
/** A refusal is a sentence, not a document: enough to read it, little enough to never buffer a page. */
const MAX_REFUSAL_BYTES = 8 * 1024;
const MAX_REFUSAL_CHARS = 200;

/**
 * What a browser looks like, because Node's own fetch does not: left to itself it announces
 * `user-agent: node` and a pair of wildcard accept headers. This site serves a plain request
 * perfectly happily, so this is politeness and not evasion.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/** The results table names itself, which is a far better anchor than "the first table on the page". */
const RESULTS_TABLE_ID = 'tablelibgen';

/**
 * The tab bar above the results, which carries its own count and is rendered whether or not a
 * table follows it. It is the one thing on the page that separates a mirror finding nothing from
 * a mirror that is not this site at all: a zero-hit search drops the table entirely rather than
 * rendering an empty one.
 */
const FILES_TAB = /curtab=f["'][^>]*>\s*Files\s*<span[^>]*>\s*\d+\s*<\/span>/i;

/**
 * Where each column sits. Positional, so a row with fewer cells than this is a header or a shape
 * change and is skipped rather than read at the wrong offsets.
 */
const MIN_ROW_CELLS = 9;
const TITLE_CELL = 0;
const AUTHOR_CELL = 1;
const YEAR_CELL = 3;
const LANGUAGE_CELL = 4;
const SIZE_CELL = 6;
const FORMAT_CELL = 7;

/**
 * Which of the site's own collections to search per medium. Ebooks span both the non-fiction and
 * fiction collections, because a request does not know which side of that line its book falls on.
 */
const TOPICS = { ebook: ['l', 'f'], comic: ['c'] };

/**
 * Rows per page. Asked for larger than any request wants because both the format and the language
 * filter are applied here rather than by the site, so much of a page is discarded. Not simply the
 * largest the site accepts: 50 rows answered in 3.3s to 4.2s and 100 in 11.3s.
 */
const PAGE_SIZE = 50;

/**
 * How far to page before giving up on finding more.
 *
 * The site has no language filter of any kind, so a title with many translations buries the wanted
 * ones: "Rose Madder Stephen King" answers with 32 Spanish rows against 9 English on its first
 * page. Stopping at that page would report a book the site plainly holds as unavailable, so the
 * search keeps turning pages until it has enough usable rows or runs out of room to look.
 */
const MAX_PAGES = 4;

/**
 * The self-imposed ceiling on a whole search, against the 20 seconds `PER_INDEXER_TIMEOUT_MS`
 * allows one indexer. Under it rather than at it, because being cut off by the host loses every
 * row already collected, while stopping here returns them.
 */
const SEARCH_BUDGET_MS = 15_000;

const MD5_IN_HREF = /(?:ads|get)\.php\?md5=([a-f0-9]{32})/i;

/**
 * The ISBNs the catalogue holds against a row, written into the only green font on the page and
 * beside the edition link rather than in a column of their own. Two thirds of rows carry them,
 * and an ISBN a request also states is worth more than every other signal put together, so this
 * is the one field here that changes which release wins rather than only how it reads.
 */
const ROW_ISBNS = /<font[^>]*color=["']green["'][^>]*>([^<]*)<\/font>/i;

/**
 * Which of the site's own columns a query is matched against. Left unset the site searches all
 * six - title, author, series, year, publisher and ISBN - which is why "Dune Frank Herbert"
 * answers with Dune Saga Collection and Sisterhood of Dune ahead of the novel: they match on a
 * series and a publisher the request never asked about.
 *
 * A comic keeps the series column, because that is where its name lives: the title of a comic row
 * is "#404 1987-feb" and the request states "Batman Year One". Measured against the comics
 * collection the column set changes nothing at all, so this is for the day that stops being true.
 */
const TEXT_COLUMNS = { ebook: ['t', 'a'], comic: ['t', 'a', 's'] };
/** The exact-edition pass matches the ISBN column and nothing else. */
const ISBN_COLUMNS = ['i'];

const DEFAULT_EBOOK_FORMATS = 'epub,mobi,azw,azw3,fb2,djvu';
const DEFAULT_COMIC_FORMATS = 'cbz,cb7,pdf';

/** Only formats BookOrbit accepts for the medium; anything else would be filtered out later. */
const ALLOWED_FORMATS = {
  ebook: ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'djvu'],
  comic: ['cbz', 'cb7', 'pdf'],
};

/** How the catalogue spells a language against what a request states. */
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

/**
 * Three-letter codes that do not simply truncate to their two-letter form, copied from the host's
 * own `release-scoring.ts` so the two agree exactly.
 *
 * They have to agree. A request states its language in either form, and this decides which rows
 * are worth a slot: a rule stricter than the scorer's would throw away rows the scorer would have
 * accepted, and the request would come back empty for a book that is sitting right there.
 */
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

export default {
  apiVersion: 1,
  version: '1.0.0',
  type: 'libgen',
  label: 'Library Genesis',
  requiresCredential: false,
  credentialKind: null,
  /**
   * Text and comics. Both are one file per release, which is what the direct download import path
   * takes. Audiobooks are left out because the catalogue is a text library: a request for one is
   * answered with "does not carry audiobooks" rather than with an empty list that reads as "not
   * available anywhere".
   */
  mediaKinds: ['ebook', 'comic'],
  usesCategories: false,
  /** Nothing is seeded back, so a seed goal here would be a number that means nothing. */
  seedsBack: false,
  defaultBaseUrl: 'https://libgen.li',
  baseUrlHint: 'The mirror you use, with no trailing path. Mirrors carry the same catalogue but differ in speed and uptime.',
  settingsFields: [
    {
      key: 'ebookFormats',
      type: 'string',
      label: 'Ebook formats',
      hint: 'Results in other formats are dropped because the site has no format filter.',
      default: DEFAULT_EBOOK_FORMATS,
      format: 'list',
      options: ALLOWED_FORMATS.ebook,
      minItems: 1,
    },
    {
      key: 'comicFormats',
      type: 'string',
      label: 'Comic formats',
      hint: 'Results in other formats are dropped because the site has no format filter.',
      default: DEFAULT_COMIC_FORMATS,
      format: 'list',
      options: ALLOWED_FORMATS.comic,
      minItems: 1,
    },
  ],

  /**
   * Two passes over the catalogue, both bounded by one budget.
   *
   * The first runs only where the request states an ISBN and matches the ISBN column alone. It is
   * the most accurate query this site accepts - measured against libgen.li it answered 51 rows for
   * Dune and every one of them was the right edition - but it cannot be the only one: the ISBN on
   * a request comes from a metadata provider and often names a foreign edition the catalogue has
   * never held, which answers with nothing at all for a book the site holds fifty copies of.
   *
   * So it is additive. Whatever it finds goes in first, and the ordinary text search fills the
   * rest, which is what keeps a wrong-edition ISBN costing one request rather than the search.
   *
   * Every page costs a round trip, so this stops at the first opportunity it gets: the moment the
   * limit is filled, the moment a short page says there is nothing more, and before starting a page
   * that the measured cost of the last one says will not finish in time.
   */
  async search(query, config, host, signal) {
    const formats = configuredFormats(config, query.mediaKind);
    if (formats.length === 0) {
      throw host.fail('unsupportedMedium', `no ${query.mediaKind} formats are configured for this indexer`);
    }

    const found = { releases: [], seen: new Set(), started: Date.now(), slowestPageMs: 0, pages: 0 };
    const passes = [];
    // One page only. Every row it can return is the same edition, so a second page of them would
    // spend a round trip on rows the first page already made the case for.
    if (query.isbn13) passes.push({ req: query.isbn13, columns: ISBN_COLUMNS, maxPages: 1, required: false });
    passes.push({ req: host.buildSearchText(query), columns: TEXT_COLUMNS[query.mediaKind] ?? [], maxPages: MAX_PAGES, required: true });

    for (const pass of passes) {
      if (found.releases.length >= query.limit) break;
      await readPass(pass, query, config, formats, host, signal, found);
    }

    logSearch(host, config, query, found.releases.length, found.pages, found.started);
    return found.releases;
  },

  async test(config, host) {
    try {
      // The same URL a real search builds, so the two cannot drift into a test that passes
      // against a shape the search no longer asks for.
      const html = await readPage(host, searchUrl(config, 'dune', 'ebook', 1, TEXT_COLUMNS.ebook).href, MAX_SEARCH_BYTES, config);
      // Either is proof this is the site. For a query this common the table alone would be, but
      // the pair is what the search now trusts and the two should not drift apart.
      if (!findTable(html, RESULTS_TABLE_ID) && !FILES_TAB.test(html)) {
        return { success: false, error: 'The mirror answered without a results table, so it is either not this site or its markup has changed' };
      }
      return { success: true, indexerName: 'Library Genesis' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      host.logger.warn(`[libgen.test] [fail] indexerId=${config.id} error="${message}" - test failed`);
      return { success: false, error: message };
    }
  },

  /**
   * Resolved for the one release an approver picked rather than during the search, because it costs
   * a request per release and the key it comes back with is short lived.
   */
  async resolveFile(release, config, host) {
    const md5 = md5Of(release);
    if (!md5) throw host.fail('error', 'that release carries no md5, so there is nothing to look up');

    const base = baseOf(config);
    const adsUrl = new URL(`${base}${ADS_PATH}`);
    adsUrl.searchParams.set('md5', md5);

    const html = await readPage(host, adsUrl.href, MAX_PAGE_BYTES, config);
    const href = firstGetLink(html);

    // The keyless form is what the comics collection links to directly, and it answers the same
    // redirect. Worth falling back to rather than failing the grab over a missing key.
    const url = href ? new URL(href, adsUrl).href : `${base}${GET_PATH}?md5=${md5}`;
    if (!href) host.logger.warn(`[libgen.resolve] [fail] indexerId=${config.id} md5=${md5} - no keyed link on the page, falling back to the plain one`);

    host.logger.log(`[libgen.resolve] [end] indexerId=${config.id} md5=${md5} keyed=${Boolean(href)} - download link resolved`);
    return toFile(url, release, host);
  },
};

/**
 * The intermediate page writes the link several ways depending on which of its templates answered,
 * so the narrowest pattern is tried first and the loosest last.
 */
const GET_LINK_PATTERNS = [
  /<a\s+href=["']([^"']*get\.php\?md5=[^"']+&(?:amp;)?key=[^"']+)["'][^>]*>\s*<h2[^>]*>\s*GET\s*<\/h2>/i,
  /<a[^>]+href=["']([^"']*get\.php\?md5=[^"']+&(?:amp;)?key=[^"']+)["']/i,
  /href=["']([^"']*get\.php\?[^"']*md5=[^"']*&(?:amp;)?[^"']*key=[^"']+)["']/i,
];

function firstGetLink(html) {
  for (const pattern of GET_LINK_PATTERNS) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeEntities(match[1]);
  }
  return null;
}

/**
 * The name the file lands under. Built from the release rather than from the link, because the link
 * is `get.php` and the real name only appears on a redirect the download client follows later.
 */
function toFile(url, release, host) {
  const format = (release.format ?? '').toLowerCase();
  if (!format) throw host.fail('error', `"${release.title}" states no format, so there is no way to name the file it would be saved as`);
  return {
    url,
    fileName: `${sanitizeName(release.title)}.${format}`,
    sizeBytes: release.sizeBytes ?? null,
    format,
  };
}

function toRelease(row, config, formats) {
  const cells = cellsOf(row);
  if (cells.length < MIN_ROW_CELLS) return null;

  const md5 = MD5_IN_HREF.exec(row)?.[1]?.toLowerCase();
  if (!md5) return null;

  // The first link to an edition carries the heading. Read as anchor text rather than by flattening
  // the cell, which would fold in the ISBN list and the badges that sit beside it.
  const heading = firstAnchorText(cells[TITLE_CELL], 'edition.php');
  const format = cellText(cells[FORMAT_CELL]).toLowerCase();
  if (!heading || !format) return null;
  if (!formats.includes(format)) return null;

  const author = trimTrailingSeparator(cellText(cells[AUTHOR_CELL]));
  const language = languageCode(cellText(cells[LANGUAGE_CELL]));
  const publishedAt = parseAdded(cellText(cells[YEAR_CELL]));

  const isbn = rowIsbns(cells[TITLE_CELL]);

  return {
    guid: md5,
    ...readTitle(cells[TITLE_CELL], heading),
    sizeBytes: parseSize(cellText(cells[SIZE_CELL])),
    // Not zero. Nothing here publishes swarm counts, and a zero would be read as a dead torrent
    // and filtered out.
    seeders: null,
    leechers: null,
    format,
    ...(language ? { language } : {}),
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(isbn ? { isbn } : {}),
    primaryFileCount: 1,
  };
}

/**
 * What to call the release, which the catalogue writes differently for a book and for a comic.
 *
 * A book's edition link is its title. A comic's is the issue designation on its own, "#404
 * 1987-feb", with the series name in a link of its own beside it, so taking the link text as the
 * title would score a request for "Batman Year One" against "#404" and drop the row. Joined back
 * together in the order a comic is normally named, and scored against the series, which is what a
 * request for one actually states.
 */
function readTitle(cell, heading) {
  const series = firstAnchorText(cell, 'series.php');
  if (series && heading.startsWith('#')) return { title: `${series} ${heading}`, bookTitle: series };

  // A title is joined to its subtitle with a semicolon. Shown with the join spelled out, and
  // scored against the bare title, which is what a request states.
  const [bare] = heading.split(';');
  return {
    title: heading.replace(/\s*;\s*/g, ': '),
    ...(bare && bare.trim() !== heading ? { bookTitle: bare.trim() } : {}),
  };
}

/**
 * Every ISBN the row states, joined, so that a request naming either the ten or the thirteen digit
 * form of the same edition matches. Read from the cell rather than from the whole row because the
 * mirrors column is also full of digits, and checked for length rather than for a checksum, which
 * is BookOrbit's to apply and not a plugin's to guess at.
 */
function rowIsbns(cell) {
  if (cell === undefined) return '';
  const raw = ROW_ISBNS.exec(cell)?.[1];
  if (!raw) return '';
  return raw
    .split(/[;,]/)
    .map((value) => value.replace(/[^0-9Xx]/g, '').toUpperCase())
    .filter((value, index, all) => (value.length === 10 || value.length === 13) && all.indexOf(value) === index)
    .join('; ');
}

/** The author column ends in a separator when the catalogue holds a single name against a row. */
function trimTrailingSeparator(value) {
  return value.replace(/[;,]+\s*$/, '').trim();
}

function searchUrl(config, text, mediaKind, page, columns) {
  const url = new URL(`${baseOf(config)}${SEARCH_PATH}`);
  url.searchParams.set('req', text);
  // Files rather than editions, so every row is something that can actually be downloaded.
  url.searchParams.append('objects[]', 'f');
  for (const topic of TOPICS[mediaKind] ?? []) url.searchParams.append('topics[]', topic);
  for (const column of columns) url.searchParams.append('columns[]', column);
  url.searchParams.set('res', String(PAGE_SIZE));
  // Left off the first page so the common search is the plain URL the site itself would produce.
  if (page > 1) url.searchParams.set('page', String(page));
  return url;
}

/**
 * Whether a row's language is one the request can accept.
 *
 * A row that states no language at all is accepted, exactly as the scorer accepts it: much of this
 * catalogue is imported metadata with the field left empty, and refusing those would discard most
 * of what the site holds over something it never claimed.
 */
function languagesAgree(requested, released) {
  if (!requested || !released) return true;
  return normalizeLanguage(requested) === normalizeLanguage(released);
}

/** Compares only the language subtag, so "en" and "eng" and "en-GB" all agree. */
function normalizeLanguage(value) {
  const subtag = value.toLowerCase().split(/[-_]/)[0];
  return ISO_639_2_TO_1[subtag] ?? subtag.slice(0, 2);
}

/** Worth a line because the page count is the one thing that explains a slow search. */
/**
 * Reads one pass to its end, adding what it finds to `found` and stopping the moment there is a
 * reason to. Shared state rather than a returned list, because both passes draw on one limit, one
 * dedupe set and one time budget, and a pass that ignored what the last one spent could not stop
 * in time.
 *
 * A pass that is not `required` never fails the search. It is a bonus query whose whole value is
 * that it sometimes answers; when it does not, the pass that follows is the one that has to
 * explain itself.
 */
async function readPass(pass, query, config, formats, host, signal, found) {
  for (let page = 1; page <= pass.maxPages; page += 1) {
    const pageStarted = Date.now();

    let html;
    try {
      html = await readPage(host, searchUrl(config, pass.req, query.mediaKind, page, pass.columns).href, MAX_SEARCH_BYTES, config);
    } catch (error) {
      // The first page of the required pass failing is the search failing, and the operator needs
      // to hear why. A later one is a page we were only hoping for: this site answers the same
      // query in 1.3s and in 25s, and throwing away the rows already in hand over the slow one
      // would turn a good search into no search at all.
      if (page === 1 && pass.required) throw error;
      host.logger.warn(
        `[libgen.search] [fail] indexerId=${config.id} page=${page} found=${found.releases.length} ` +
          `error="${error instanceof Error ? error.message : String(error)}" - keeping what earlier pages found`,
      );
      return;
    }

    const table = findTable(html, RESULTS_TABLE_ID);

    if (!table) {
      // A zero-hit search drops the table rather than rendering an empty one, so the tab bar is
      // what decides: still there and this is the site answering with nothing, gone as well and
      // it is not this site. On a later page it is simply the end of the results, and everything
      // already collected still stands.
      if (page === 1 && pass.required && !FILES_TAB.test(html)) {
        throw host.fail('unreachable', 'the mirror answered without a results table or a tab bar, so it is either not this site or its markup has changed');
      }
      return;
    }

    const rows = rowsOf(table);
    found.pages += 1;

    for (const row of rows) {
      const release = toRelease(row, config, formats);
      if (!release || found.seen.has(release.guid)) continue;
      // Dropped here rather than left to the scorer, which is the entire reason for paging: a
      // slot spent on a language the request cannot accept is a slot the wanted edition needed.
      if (!languagesAgree(query.language, release.language)) continue;
      found.seen.add(release.guid);
      found.releases.push(release);
      if (found.releases.length >= query.limit) return;
    }

    // Counted from the rows the site actually filled rather than from the parsed ones, because a
    // page can be full and still yield nothing usable, and that is a reason to keep going.
    if (rows.filter((row) => MD5_IN_HREF.test(row)).length < PAGE_SIZE) return;
    if (signal?.aborted) return;

    found.slowestPageMs = Math.max(found.slowestPageMs, Date.now() - pageStarted);
    if (Date.now() - found.started + found.slowestPageMs > SEARCH_BUDGET_MS) return;
  }
}

function logSearch(host, config, query, found, pages, started) {
  host.logger.log(
    `[libgen.search] [end] indexerId=${config.id} medium=${query.mediaKind} language=${query.language ?? 'any'} ` +
      `pages=${pages} found=${found} durationMs=${Date.now() - started} - search finished`,
  );
}

function configuredFormats(config, mediaKind) {
  const raw = mediaKind === 'comic' ? config.settings?.comicFormats : config.settings?.ebookFormats;
  const fallback = mediaKind === 'comic' ? DEFAULT_COMIC_FORMATS : DEFAULT_EBOOK_FORMATS;
  const allowed = ALLOWED_FORMATS[mediaKind] ?? [];

  return splitList(typeof raw === 'string' && raw.trim() ? raw : fallback)
    .map((format) => format.toLowerCase().replace(/^\./, ''))
    .filter((format, index, all) => allowed.includes(format) && all.indexOf(format) === index);
}

function splitList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function baseOf(config) {
  return config.baseUrl.replace(/\/+$/, '');
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function md5Of(release) {
  const guid = typeof release.guid === 'string' ? release.guid.trim().toLowerCase() : '';
  return /^[a-f0-9]{32}$/.test(guid) ? guid : null;
}

/** A fetch and a bounded read, with the failures a public mirror actually has. */
async function readPage(host, url, limit, config) {
  const response = await host.fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: HTML_ACCEPT, 'Accept-Language': ACCEPT_LANGUAGE },
  });

  if (response.status === 429) throw host.fail('throttled', 'the mirror is rate limiting us');
  if (!response.ok) throw host.fail('error', `the mirror answered ${response.status}${await readRefusal(response)}`);

  const text = await readBoundedText(response, limit);
  if (text.length === 0) throw host.fail('unreachable', 'the mirror answered with an empty page');
  host.logger.log(`[libgen.fetch] [end] indexerId=${config.id} host=${hostOf(url)} bytes=${text.length} - page read`);
  return text;
}

/**
 * Reads a response body up to a byte ceiling and stops, rather than trusting a source to send
 * something sensible. A result page is the largest thing here and it is still markup, so a body
 * that runs past the ceiling is a stream that will not end and not a page worth having.
 */
async function readBoundedText(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readRefusal(response) {
  const flattened = stripTags(await readBoundedText(response, MAX_REFUSAL_BYTES));
  return flattened ? `: ${flattened.slice(0, MAX_REFUSAL_CHARS)}` : '';
}

/**
 * The end of the tag that starts at `start`, skipping any `>` sitting inside a quoted attribute.
 *
 * Not pedantry. Every row's title link carries a tooltip whose `title` attribute contains a literal
 * `<br>`, so the usual `<[^>]*>` ends the tag in the middle of an attribute and the href after it
 * is never seen. That is one silently empty search, which is the failure this whole file is written
 * to avoid.
 */
function tagEnd(html, start) {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

/** The inner HTML of the first element whose opening tag carries `id="<id>"`. */
function findTable(html, id) {
  const marker = new RegExp(`<table[^>]*id=["']${id}["']`, 'i').exec(html);
  if (!marker) return null;
  const open = tagEnd(html, marker.index);
  if (open === -1) return null;
  const close = html.toLowerCase().indexOf('</table>', open);
  return close === -1 ? html.slice(open + 1) : html.slice(open + 1, close);
}

/** Only rows with cells in them, which drops the header without having to recognise it. */
function rowsOf(table) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]).filter((row) => /<td\b/i.test(row));
}

function cellsOf(row) {
  const cells = [];
  const opens = /<td\b/gi;
  let match;
  while ((match = opens.exec(row)) !== null) {
    const open = tagEnd(row, match.index);
    if (open === -1) break;
    const close = row.toLowerCase().indexOf('</td>', open);
    if (close === -1) {
      cells.push(row.slice(open + 1));
      break;
    }
    cells.push(row.slice(open + 1, close));
    opens.lastIndex = close;
  }
  return cells;
}

/** The text of the first anchor whose href contains `needle`, with its own markup stripped out. */
function firstAnchorText(cell, needle) {
  if (cell === undefined) return '';
  const opens = /<a\b/gi;
  let match;
  while ((match = opens.exec(cell)) !== null) {
    const open = tagEnd(cell, match.index);
    if (open === -1) return '';
    const tag = cell.slice(match.index, open + 1);
    const close = cell.toLowerCase().indexOf('</a>', open);
    if (close === -1) return '';
    if (tag.includes(needle)) return stripTags(cell.slice(open + 1, close));
    opens.lastIndex = close;
  }
  return '';
}

function cellText(cell) {
  return cell === undefined ? '' : stripTags(cell);
}

function stripTags(html) {
  let out = '';
  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf('<', cursor);
    if (open === -1) {
      out += html.slice(cursor);
      break;
    }
    out += html.slice(cursor, open);
    const close = tagEnd(html, open);
    if (close === -1) break;
    cursor = close + 1;
  }
  return normalizeText(out);
}

function normalizeText(value) {
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * A language cell, as an ISO 639-1 code or as nothing.
 *
 * Nothing rather than a guess, because a stated language is a hard filter: the scorer reads the
 * first two characters of whatever arrives, so passing "German" through would compare "ge" against
 * "de" and drop every German release from a German request. Plenty of rows state no language at
 * all, and those are left unstated so the filter skips them.
 */
function languageCode(value) {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  const named = LANGUAGE_BY_NAME[trimmed.split(/[,;(/]/)[0].trim()];
  if (named) return named;
  return /^[a-z]{2,3}$/.test(trimmed) ? trimmed : null;
}

/**
 * The year column carries either a bare year or a full `2021:05:04` date. Only the full form
 * becomes a publication date; a bare year would invent a January the first that nobody stated.
 */
function parseAdded(value) {
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(value.trim());
  if (!match) return undefined;
  const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Sizes are stated in the table as "702 kB" or "10 MB". */
function parseSize(value) {
  const match = /([\d.]+)\s*([KMGT]?i?B)/i.exec(value);
  if (!match) return null;
  const units = { b: 1, kb: 1000, kib: 1024, mb: 1000 ** 2, mib: 1024 ** 2, gb: 1000 ** 3, gib: 1024 ** 3, tb: 1000 ** 4, tib: 1024 ** 4 };
  const bytes = Number(match[1]) * (units[match[2].toLowerCase()] ?? 1);
  return Number.isFinite(bytes) ? Math.round(bytes) : null;
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
