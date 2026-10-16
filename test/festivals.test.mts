import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const catalog = await import('@/lib/festivals/catalog');
const { pickTheme, upcomingFestivals } = await import('@/lib/festivals/select');
const { addDays } = await import('@/lib/festivals/dates');
const fd = await import('@/lib/server/festivalDates');

const NOW = new Date('2026-10-15T08:00:00Z');

function offline(year: number, id: string) {
  const e = fd.offlineFestivalDates(year).find((x) => x.id === id);
  assert.ok(e, `${id} ${year} has an offline date`);
  return e;
}

// ---- Offline dates ----------------------------------------------------------

test('offline Islamic dates for 2026 follow Umm al-Qura', () => {
  const ramadan = offline(2026, 'ramadan');
  assert.ok(['2026-02-18', '2026-02-19'].includes(ramadan.start), ramadan.start);
  assert.equal(offline(2026, 'eid-al-fitr').start, '2026-03-20');
  assert.equal(ramadan.end, '2026-03-19', 'Ramadan ends the day before Eid');
  const adha = offline(2026, 'eid-al-adha');
  assert.equal(adha.start, '2026-05-26', 'the window opens on Arafat Day');
  assert.equal(addDays(adha.start, 1), '2026-05-27', 'Eid al-Adha itself');
  assert.equal(offline(2026, 'islamic-new-year').start, '2026-06-16');
  assert.equal(offline(2026, 'laylat-al-qadr').start, '2026-03-16'); // 27 Ramadan
});

test('Easter by the computus, Gregorian and Julian', () => {
  assert.equal(offline(2026, 'good-friday').start, '2026-04-03');
  assert.equal(fd.westernEaster(2026), '2026-04-05');
  assert.equal(offline(2026, 'easter').end, '2026-04-06', 'through Easter Monday');
  assert.equal(fd.westernEaster(2027), '2027-03-28');
  assert.equal(fd.westernEaster(2028), '2028-04-16');
  assert.equal(fd.orthodoxEaster(2026), '2026-04-12');
  assert.equal(fd.orthodoxEaster(2027), '2027-05-02');
  assert.equal(fd.orthodoxEaster(2028), '2028-04-16');
});

test('Chinese and Persian calendars and fixed days', () => {
  assert.equal(offline(2026, 'lunar-new-year').start, '2026-02-17');
  assert.equal(offline(2027, 'lunar-new-year').start, '2027-02-06', 'ICU says 7 Feb; corrected');
  assert.equal(offline(2030, 'lunar-new-year').start, '2030-02-03', 'ICU says 2 Feb; corrected');
  assert.equal(offline(2031, 'laylat-al-qadr').start.slice(0, 7), '2031-01', 'from the Ramadan that began in Dec 2030');
  assert.equal(offline(2026, 'nowruz').start, '2026-03-21');
  assert.deepEqual([offline(2026, 'uae-national-day').start, offline(2026, 'uae-national-day').end], ['2026-12-02', '2026-12-03']);
  assert.equal(offline(2026, 'uae-mothers-day').start, '2026-03-21');
  assert.equal(offline(2026, 'diwali').start, '2026-11-06', 'Dhanteras, two days before Lakshmi Puja on 8 Nov');
});

test('every catalogue festival has an offline date in each table year', () => {
  for (let y = 2026; y <= 2032; y++) {
    const ids = new Set(fd.offlineFestivalDates(y).map((e) => e.id));
    for (const f of catalog.FESTIVALS) assert.ok(ids.has(f.id), `${f.id} ${y}`);
  }
});

// ---- Window rules -------------------------------------------------------------

const ev = (id: string, start: string, end = start) => ({ id, start, end });

test('a tier-1 festival shows from 21 days before until 7 days after', () => {
  const events = [ev('diwali', '2030-10-24', '2030-10-28')];
  const at = (today: string) => pickTheme({ today, events });
  assert.equal(at('2030-10-02').themeId, 'default');
  assert.deepEqual([at('2030-10-03').themeId, at('2030-10-03').phase, at('2030-10-03').daysToStart], ['diwali', 'upcoming', 21]);
  assert.equal(at('2030-10-26').phase, 'during');
  assert.equal(at('2030-11-04').phase, 'after');
  assert.equal(at('2030-11-05').themeId, 'default');
});

test('a tier-2 festival gets the short window: 7 days before, 2 after', () => {
  const events = [ev('vishu', '2030-04-14')];
  assert.equal(pickTheme({ today: '2030-04-06', events }).themeId, 'default');
  assert.equal(pickTheme({ today: '2030-04-07', events }).themeId, 'vishu');
  assert.equal(pickTheme({ today: '2030-04-16', events }).phase, 'after');
  assert.equal(pickTheme({ today: '2030-04-17', events }).themeId, 'default');
});

test('overlaps: running beats upcoming; tier, then priority; upcoming beats a tail', () => {
  // Two tier-1 festivals running: higher priority wins.
  const both = [ev('lunar-new-year', '2030-02-03', '2030-02-09'), ev('eid-al-fitr', '2030-02-05', '2030-02-07')];
  assert.equal(pickTheme({ today: '2030-02-06', events: both }).themeId, 'eid-al-fitr');
  // A running tier-2 festival shows on its day even inside a tier-1 lead window...
  const flag = [ev('uae-flag-day', '2030-11-03'), ev('uae-national-day', '2030-12-02', '2030-12-03')];
  assert.equal(pickTheme({ today: '2030-11-03', events: flag }).themeId, 'uae-flag-day');
  // ...but in lead windows, tier 1 comes first even when the tier-2 one is nearer.
  assert.equal(pickTheme({ today: '2030-11-12', events: [...flag, ev('gurpurab', '2030-11-14')] }).themeId, 'uae-national-day');
  // A running tier-1 festival beats a running tier-2 one.
  assert.equal(pickTheme({ today: '2030-02-14', events: [ev('ramadan', '2030-01-05', '2030-02-03'), ev('christmas', '2030-02-13', '2030-02-14'), ev('valentines-day', '2030-02-14')] }).themeId, 'christmas');
  // Same tier, nothing running: upcoming beats one that has just ended.
  const r = pickTheme({ today: '2030-12-27', events: [ev('christmas', '2030-12-24', '2030-12-25'), ev('new-year', '2031-01-01')] });
  assert.deepEqual([r.themeId, r.phase, r.daysToStart], ['new-year', 'upcoming', 5]);
});

test('solemn days show only on the day, calmly, over anything else', () => {
  const events = [ev('commemoration-day', '2030-11-30'), ev('uae-national-day', '2030-12-02', '2030-12-03')];
  assert.equal(pickTheme({ today: '2030-11-29', events }).themeId, 'uae-national-day');
  assert.equal(pickTheme({ today: '2030-11-30', events }).themeId, 'commemoration-day');
  const easter = [ev('good-friday', '2030-04-19', '2030-04-20'), ev('easter', '2030-04-19', '2030-04-22')];
  assert.equal(pickTheme({ today: '2030-04-12', events: easter }).themeId, 'easter', 'no countdown to Good Friday');
  assert.equal(pickTheme({ today: '2030-04-19', events: easter }).themeId, 'good-friday');
  assert.equal(pickTheme({ today: '2030-04-21', events: easter }).themeId, 'easter');
  for (const id of ['good-friday', 'commemoration-day']) {
    const t = catalog.themeFor(id);
    assert.ok(!/[%🎁🎉🎊🎆]|sale|offer|discount|gift|deliver/i.test([t.greeting, t.headline, ...t.marquee].join(' ')), id);
    // Understated: stone grey and a quiet motif, never party ornaments.
    assert.equal(t.palette, 'stone', id);
    assert.ok(['olive', 'dove'].includes(t.motif), id);
  }
});

test('Ramadan flows into Eid al-Fitr over its last 3 days; Laylat al-Qadr never takes over', () => {
  const events = [ev('ramadan', '2030-01-05', '2030-02-03'), ev('laylat-al-qadr', '2030-01-31'), ev('eid-al-fitr', '2030-02-04', '2030-02-06')];
  assert.equal(pickTheme({ today: '2029-12-20', events }).themeId, 'ramadan', 'Ramadan lead');
  assert.equal(pickTheme({ today: '2030-01-20', events }).themeId, 'ramadan');
  assert.equal(pickTheme({ today: '2030-01-31', events }).themeId, 'ramadan');
  assert.equal(pickTheme({ today: '2030-02-01', events }).themeId, 'eid-al-fitr');
  assert.equal(pickTheme({ today: '2030-02-01', events }).phase, 'upcoming');
  assert.equal(pickTheme({ today: '2030-02-04', events }).phase, 'during');
});

test('manual and off override the calendar', () => {
  const events = [ev('diwali', '2030-10-24', '2030-10-28')];
  assert.equal(pickTheme({ today: '2030-10-25', events, override: { mode: 'off' } }).themeId, 'default');
  const m = pickTheme({ today: '2030-06-01', events, override: { mode: 'manual', themeId: 'christmas' } });
  assert.deepEqual([m.themeId, m.festivalId], ['christmas', 'christmas']);
  assert.equal(pickTheme({ today: '2030-10-25', events, override: { mode: 'manual', themeId: 'nope' } }).themeId, 'default');
  assert.equal(pickTheme({ today: '2030-10-25', events, override: { mode: 'auto' } }).themeId, 'diwali');
  assert.equal(pickTheme({ today: 'not a date', events }).themeId, 'default');
});

test('upcomingFestivals lists what is running and next, in order', () => {
  const events = [ev('christmas', '2030-12-24', '2030-12-25'), ev('diwali', '2030-10-24', '2030-10-28'), ev('vishu', '2030-04-14'), ev('uae-national-day', '2030-12-02', '2030-12-03')];
  const list = upcomingFestivals('2030-10-25', events, 2);
  assert.deepEqual(list.map((x) => [x.id, x.phase]), [['diwali', 'during'], ['uae-national-day', 'upcoming']]);
  assert.equal(list[1].themeFrom, '2030-11-11');
  assert.equal(list[1].daysToStart, 38);
});

// ---- iCalendar ----------------------------------------------------------------

const ICS_INDIAN = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:Holidays in India',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20271028',
  'DTEND;VALUE=DATE:20271029',
  'SUMMARY:Diwali/Deep',
  ' avali', // folded line
  'BEGIN:VALARM',
  'SUMMARY:Holi',
  'DTSTART;VALUE=DATE:20270101',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20270322',
  'SUMMARY:Holi',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20270101',
  'SUMMARY:Bank Holiday',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20280715',
  'SUMMARY:Holi', // five months off: must fail the sanity check
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20270230',
  'SUMMARY:Raksha Bandhan', // not a real date
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:garbage',
  'SUMMARY:Onam',
  'END:VEVENT',
  'this line has no colon',
  'END:VCALENDAR',
].join('\r\n');

test('the iCalendar reader unfolds lines, reads DATE and DATE-TIME, skips junk', () => {
  const events = fd.parseIcs(ICS_INDIAN);
  assert.deepEqual(events[0], { summary: 'Diwali/Deepavali', start: '2027-10-28', end: '2027-10-28' });
  assert.deepEqual(events.map((e) => e.summary), ['Diwali/Deepavali', 'Holi', 'Bank Holiday', 'Holi']);

  const dt = fd.parseIcs(
    'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261107T210000Z\nDTEND:20261107T230000Z\nSUMMARY:Late\\, UTC\nEND:VEVENT\n' +
      'BEGIN:VEVENT\nDTSTART;TZID=Asia/Dubai:20261231T233000\nSUMMARY:Local\nEND:VEVENT\nEND:VCALENDAR\n',
  );
  assert.deepEqual(dt[0], { summary: 'Late, UTC', start: '2026-11-08', end: '2026-11-08' }, '21:00 UTC is 01:00 the next day in Dubai');
  assert.equal(dt[1].start, '2026-12-31');
  assert.throws(() => fd.parseIcs('X'.repeat(fd.MAX_ICS_BYTES + 1)), /2 MB/);
  assert.deepEqual(fd.parseIcs(''), []);
});

test('matching: "Holiday" is not Holi, and an out-of-range date is rejected', () => {
  const rules = fd.FESTIVAL_FEEDS.find((f) => f.name === 'google:indian')!.rules;
  const { accepted, rejected } = fd.matchFeedEvents(fd.parseIcs(ICS_INDIAN), rules, 'google:indian', { min: 2026, max: 2031 });
  assert.deepEqual(
    accepted.map((a) => [a.id, a.year, a.start]).sort(),
    [['diwali', 2027, '2027-10-26'], ['holi', 2027, '2027-03-21']],
  );
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /^holi 2028: .* 2028-07-14 is \d+ days from the expected 2028-03-10; kept 2028-03-10/);
});

// ---- Refresh -------------------------------------------------------------------

const ics = (...events: Array<[string, string]>) =>
  ['BEGIN:VCALENDAR', ...events.flatMap(([date, summary]) => ['BEGIN:VEVENT', `DTSTART;VALUE=DATE:${date}`, `SUMMARY:${summary}`, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');

test('refresh: one feed failing does not stop the others; UAE dates win; never throws', async () => {
  const eid = offline(2027, 'eid-al-fitr').start.replaceAll('-', '');
  const eidUae = addDays(offline(2027, 'eid-al-fitr').start, 1);
  const fetcher = async (url: string) => {
    if (url.includes('en.indian')) return ICS_INDIAN;
    if (url.includes('en.islamic')) return ics([eid, 'Eid al-Fitr'], ['20270101', 'New Year’s Day']);
    if (url.includes('en.ae')) return ics([eidUae.replaceAll('-', ''), 'Eid al-Fitr Holiday']);
    if (url.includes('en.christian')) throw new Error('connect ECONNREFUSED');
    if (url.includes('en.china')) return 'X'.repeat(fd.MAX_ICS_BYTES + 10);
    return 'not a calendar';
  };
  const r = await fd.refreshFestivalDates(fetcher, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.fetchedAt, NOW.toISOString());
  assert.ok(r.errors.some((e) => e.startsWith('google:christian: ') && /ECONNREFUSED/.test(e)), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => e.startsWith('google:china: ') && /2 MB/.test(e)));
  assert.ok(r.updated.includes('diwali 2027: 2027-10-26'), r.updated.join('\n'));
  assert.ok(r.updated.includes(`eid-al-fitr 2027: ${eidUae}`));
  assert.ok(r.rejected.some((x) => x.startsWith('holi 2028')));

  const cal = fd.festivalCalendar(2027);
  const get = (id: string) => cal.find((e) => e.id === id && e.year === 2027)!;
  assert.deepEqual([get('diwali').start, get('diwali').end, get('diwali').source], ['2027-10-26', '2027-10-30', 'google:indian']);
  assert.deepEqual([get('eid-al-fitr').start, get('eid-al-fitr').source], [eidUae, 'google:uae']);
  assert.equal(get('ramadan').end, addDays(eidUae, -1), 'Ramadan runs until the day before the official Eid');
  assert.equal(get('holi').start, '2027-03-21');
  assert.equal(cal.find((e) => e.id === 'holi' && e.year === 2028)!.start, '2028-03-10', 'rejected date kept offline');
  assert.equal(get('christmas').source, 'offline');

  // Recorded, and a second run with the same data changes nothing.
  assert.equal(fd.lastFestivalRefresh()?.fetchedAt, NOW.toISOString());
  const again = await fd.refreshFestivalDates(fetcher, NOW);
  assert.deepEqual(again.updated, []);
  assert.equal(await fd.maybeRefreshFestivalDates({ fetcher, now: new Date(NOW.getTime() + 3600_000) }), null, 'fresh: no refresh');

  // A fetcher that throws synchronously or returns junk still yields a result.
  const bad = await fd.refreshFestivalDates((() => { throw new Error('boom'); }) as never, NOW);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, fd.FESTIVAL_FEEDS.length);
});

test('currentFestivalTheme uses the stored calendar and the override', () => {
  const now = new Date('2027-10-20T20:30:00Z'); // 21 Oct in Dubai
  const cur = fd.currentFestivalTheme(undefined, now);
  assert.equal(cur.today, '2027-10-21');
  assert.equal(cur.pick.themeId, 'diwali');
  assert.equal(cur.pick.daysToStart, 5);
  assert.equal(cur.theme.greeting, 'Happy Diwali');
  assert.ok(cur.upcoming.length > 0);
  assert.equal(fd.currentFestivalTheme({ mode: 'off' }, now).theme, catalog.DEFAULT_THEME);
});

test('the default fetcher refuses responses over 2 MB', async () => {
  const big = 'A'.repeat(fd.MAX_ICS_BYTES + 1);
  const server = http.createServer((req, res) => {
    if (req.url === '/declared') res.writeHead(200, { 'content-length': String(big.length) }).end(big);
    else if (req.url === '/chunked') { res.writeHead(200); res.write(big.slice(0, 1_000_000)); res.write(big.slice(1_000_000)); res.end(); }
    else if (req.url === '/ok') res.writeHead(200).end('BEGIN:VCALENDAR\r\nEND:VCALENDAR');
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await assert.rejects(fd.defaultFetcher(`${base}/declared`), /2 MB/);
    await assert.rejects(fd.defaultFetcher(`${base}/chunked`), /2 MB/);
    await assert.rejects(fd.defaultFetcher(`${base}/missing`), /HTTP 404/);
    assert.match(await fd.defaultFetcher(`${base}/ok`), /VCALENDAR/);
  } finally {
    server.close();
  }
});

// ---- Catalogue ------------------------------------------------------------------

test('every festive accent is readable on the shop\'s ivory and on its own greeting band', () => {
  const ivory = catalog.BRAND_IVORY;
  for (const [id, a] of Object.entries(catalog.FESTIVE_ACCENTS)) {
    assert.ok(catalog.contrastRatio(a.accent, ivory) >= 4.5, `${id} accent on ivory`);
    assert.ok(catalog.contrastRatio(a.accent, '#ffffff') >= 4.5, `${id} accent on white`);
    assert.ok(catalog.contrastRatio(a.accent, a.soft) >= 4.5, `${id} accent on its band`);
    assert.ok(catalog.contrastRatio('#5a4c53', a.soft) >= 4.5, `${id}: the band's second line (ink-soft)`);
    assert.ok(catalog.contrastRatio('#ffffff', a.bar) >= 4.5, `${id}: the status bar's white text`);
    // The motif and the ring are fine lines: visible on the band (3:1 for the accent-coloured motif).
    assert.ok(catalog.contrastRatio(a.accent, a.soft) >= 3, `${id} motif`);
  }
  for (const [id, t] of [['default', catalog.DEFAULT_THEME] as const, ...catalog.FESTIVALS.map((f) => [f.id, f.theme] as const)]) {
    assert.deepEqual([t.accent, t.accentSoft, t.glow, t.bar], Object.values(catalog.FESTIVE_ACCENTS[t.palette]), `${id} uses its curated accent only`);
  }
  assert.ok(catalog.contrastRatio(catalog.BRAND_GOLD, '#ffffff') < 3, 'why the champagne gold is never text on white');
  assert.equal(catalog.contrastRatio('#000000', '#ffffff').toFixed(0), '21');
});

test('each festival keeps to the palette: Eid in emerald, Diwali in saffron, Christmas in berry, National Day with a nod to the flag', () => {
  const look = (id: string) => [catalog.themeFor(id).palette, catalog.themeFor(id).motif];
  assert.deepEqual(look('eid-al-fitr'), ['emerald', 'crescent']);
  assert.deepEqual(look('eid-al-adha'), ['emerald', 'crescent']);
  assert.deepEqual(look('ramadan'), ['emerald', 'lantern']);
  assert.deepEqual(look('diwali'), ['saffron', 'diya']);
  assert.deepEqual(look('christmas'), ['berry', 'snowflake']);
  assert.deepEqual(look('uae-national-day'), ['emerald', 'flag']);
  assert.deepEqual(look('default'), ['gold', 'sparkle']);
  // A short, gracious greeting: no emoji, no shouting.
  const emoji = /\p{Extended_Pictographic}/u;
  for (const f of catalog.FESTIVALS) {
    const t = f.theme;
    for (const line of [t.greeting, t.headline, ...t.marquee]) {
      assert.ok(!emoji.test(line), `${f.id}: no emoji in "${line}"`);
      assert.ok(!/!|[A-Z]{4,}/.test(line), `${f.id}: no shouting in "${line}"`);
    }
    assert.ok(t.greeting.length <= 40, `${f.id} greeting is short`);
  }
});

test('the catalogue is complete and well-formed', () => {
  const ids = catalog.FESTIVALS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const need of [
    'ramadan', 'eid-al-fitr', 'eid-al-adha', 'islamic-new-year', 'mawlid', 'isra-miraj', 'laylat-al-qadr', 'diwali', 'holi',
    'good-friday', 'easter', 'christmas', 'new-year', 'uae-national-day', 'uae-mothers-day', 'uae-flag-day', 'commemoration-day',
    'emirati-womens-day', 'lunar-new-year', 'nowruz', 'onam', 'vishu', 'pongal', 'navratri-dussehra', 'raksha-bandhan',
    'ganesh-chaturthi', 'vaisakhi', 'gurpurab', 'orthodox-christmas', 'orthodox-easter',
  ]) assert.ok(ids.includes(need), need);
  const hex = /^#[0-9a-f]{6}$/i;
  for (const f of catalog.FESTIVALS) {
    assert.ok(f.durationDays >= 1 && f.durationDays <= 30, f.id);
    assert.ok(f.tier === 1 || f.tier === 2, f.id);
    const t = f.theme;
    assert.ok([t.accent, t.accentSoft, t.glow, t.bar].every((c) => hex.test(c)), `${f.id} colours`);
    assert.ok(t.palette in catalog.FESTIVE_ACCENTS, `${f.id} palette`);
    assert.ok((catalog.MOTIFS as readonly string[]).includes(t.motif), `${f.id} motif`);
    assert.ok(t.greeting && t.headline.length <= 80, `${f.id} text`);
    assert.ok(t.marquee.length >= 1 && t.marquee.length <= 3, `${f.id} marquee`);
    if (f.parent) assert.ok(ids.includes(f.parent), `${f.id} parent`);
  }
  assert.equal(catalog.themeFor('nope'), catalog.DEFAULT_THEME);
  assert.deepEqual(catalog.themeIds().slice(0, 2), ['default', catalog.FESTIVALS[0].id]);
});
