const ical = require('node-ical');

/*
 * GET /api/calendar
 *
 * Returns upcoming family calendar events as JSON.
 * Reads iCal feed URLs from environment variables:
 *   ICAL_FAMILY   — secret iCal address for the shared family calendar; when set, it is
 *                   the only source used and the per-person feeds below are ignored
 *   ICAL_JARVIS  — secret iCal address for the Jarvis family calendar (preferred)
 *   ICAL_MARK     — secret iCal address for Mark's calendar (optional)
 *   ICAL_MELANIE  — secret iCal address for Melanie's calendar (optional)
 *   ICAL_HARRY    — secret iCal address for Harry's calendar (optional)
 *   ICAL_CHARLIZE — secret iCal address for Charlize's calendar (optional)
 *
 * To get a secret iCal URL:
 *   Google Calendar → Settings → [Calendar name] →
 *   "Integrate calendar" → "Secret address in iCal format"
 *
 * IMPORTANT: use a dedicated family/shared calendar's iCal URL,
 * not your main calendar, to avoid personal/work events appearing.
 *
 * Optional keyword blocklist (comma-separated, case-insensitive):
 *   ICAL_EXCLUDE=standup,1:1,interview,dentist
 *
 * Optional attendee-domain filter (recommended):
 *   FAMILY_DOMAIN=kramlem.com
 *   Events with any attendee outside this domain are excluded.
 *   Events with no attendees are always kept.
 */

const DAYS_AHEAD = 14;

// Public holidays: Google's public "Holidays in Australia" feed (no setup needed).
// It mixes every state, so only national + NSW holidays are kept. Shared-date
// "(regional holiday)" entries are the NSW dates (verified); state-named ones
// (Victoria, Queensland, WA, NT, Tasmania, ...) are dropped by omission.
// Set ICAL_HOLIDAYS=off to disable, or to a URL to use another feed.
const HOLIDAYS_URL = 'https://calendar.google.com/calendar/ical/en.australian%23holiday%40group.v.calendar.google.com/public/basic.ics';
const HOLIDAY_KEEP = /^(New Year's Day|Australia Day( Observed)?|Good Friday|Holy Saturday|Easter (Sunday|Monday)|ANZAC Day|King's Birthday|Labour Day|Christmas Day|Boxing Day)( \(regional holiday\))?$/;

function fetchCalendar(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 8000);
    ical.fromURL(url, {}, (err, data) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(data);
    });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  // Build blocklist from ICAL_EXCLUDE env var (comma-separated keywords)
  const excludeTerms = (process.env.ICAL_EXCLUDE || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  function isExcluded(summary) {
    if (!excludeTerms.length) return false;
    const lower = (summary || '').toLowerCase();
    return excludeTerms.some(term => lower.includes(term));
  }

  // Filter events that have an attendee outside the family domain.
  // Events with no attendees are kept (personal reminders, all-day markers, etc.)
  const familyDomain = (process.env.FAMILY_DOMAIN || '').toLowerCase().trim();

  function hasExternalAttendee(ev) {
    if (!familyDomain) return false; // env var not set → no filtering
    const raw = ev.attendee;
    if (!raw) return false; // no attendees → keep
    const list = Array.isArray(raw) ? raw : [raw];
    return list.some(a => {
      // node-ical returns attendee objects with a .val like "mailto:user@example.com"
      const mailto = (typeof a === 'string' ? a : (a.val || '')).toLowerCase();
      const match  = mailto.match(/mailto:([^@]+@([^;>\s]+))/);
      if (!match) return false;
      return match[2] !== familyDomain;
    });
  }

  // ICAL_FAMILY (the shared family calendar) takes priority and is used on its own;
  // unset it to fall back to the per-person feeds below.
  const sources = (process.env.ICAL_FAMILY
    ? [{ url: process.env.ICAL_FAMILY, name: 'Family' }]
    : [
        { url: process.env.ICAL_JARVIS,   name: 'Jarvis' },
        { url: process.env.ICAL_MARK,     name: 'Mark' },
        { url: process.env.ICAL_MELANIE,  name: 'Melanie' },
        { url: process.env.ICAL_HARRY,    name: 'Harry' },
        { url: process.env.ICAL_CHARLIZE, name: 'Charlize' },
      ]
  ).filter(s => s.url);

  if (!sources.length) {
    return res.status(500).json({
      error: 'No calendar URLs configured.',
      hint: 'Add ICAL_JARVIS (and/or ICAL_MARK, ICAL_MELANIE, ICAL_HARRY, ICAL_CHARLIZE) as Vercel environment variables.',
    });
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);

  const fetches = sources.map(async ({ url, name }) => {
    try {
      const data = await fetchCalendar(url);
      return { name, data };
    } catch {
      return { name, data: {} };
    }
  });

  const holidaysUrl = process.env.ICAL_HOLIDAYS === 'off' ? '' : (process.env.ICAL_HOLIDAYS || HOLIDAYS_URL);
  if (holidaysUrl) {
    fetches.push(fetchCalendar(holidaysUrl)
      .then(data => {
        for (const k of Object.keys(data)) {
          const e = data[k];
          if (e.type === 'VEVENT') e.isHoliday = true;
        }
        return { name: 'Holidays', data };
      })
      .catch(() => ({ name: 'Holidays', data: {} })));
  }

  const results = await Promise.all(fetches);

  const seen = new Set();
  const events = [];
  const debug = req.query && req.query.debug === '1';
  const skipped = [];
  const skip = (ev, why) => { if (debug) skipped.push({ summary: ev.summary, start: String(ev.start), why }); };

  const asDate = v => (v instanceof Date ? v : (v ? new Date(v) : null));
  const dayKey = d => d.toISOString().slice(0, 10);

  // Expand one VEVENT into the occurrences that start (or, for all-day, run) now..cutoff.
  function occurrences(ev) {
    const start = asDate(ev.start);
    if (!start || isNaN(start)) return [];
    const end = asDate(ev.end);
    const dur = end ? end - start : 0;
    const allDay = ev.datetype === 'date';
    const out = [];
    const add = (s, e, over) => {
      const e2 = e || (dur ? new Date(s.getTime() + dur) : null);
      const ongoingAllDay = allDay && e2 && e2 > now;
      if ((s < now && !ongoingAllDay) || s > cutoff) return;
      out.push({ ev: over || ev, start: s, end: e2 });
    };

    if (ev.rrule) {
      const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
      let dates = [];
      try { dates = ev.rrule.between(dayAgo, cutoff, true); } catch { dates = []; }
      for (const d of dates) {
        const k = dayKey(d);
        if (ev.exdate && Object.values(ev.exdate).some(x => dayKey(asDate(x)) === k)) continue;
        const over = ev.recurrences && Object.values(ev.recurrences).find(r => dayKey(asDate(r.start)) === k);
        if (over) { add(asDate(over.start), asDate(over.end), over); continue; }
        add(d, null);
      }
      // Moved occurrences whose original date fell outside the window
      for (const r of Object.values(ev.recurrences || {})) add(asDate(r.start), asDate(r.end), r);
    } else {
      add(start, end);
    }
    return out;
  }

  // The family-domain guest filter only applies to the old per-person feeds.
  const useGuestFilter = !process.env.ICAL_FAMILY;

  for (const { data } of results) {
    for (const ev of Object.values(data)) {
      if (ev.type !== 'VEVENT') continue;
      if (ev.isHoliday && !HOLIDAY_KEEP.test((ev.summary || '').trim())) continue;

      for (const { ev: e, start, end } of occurrences(ev)) {
        // Deduplicate before filtering so a filtered event blocks all its duplicates
        const key = (e.summary || '') + '|' + start.toISOString().slice(0, 16);
        if (seen.has(key)) continue;
        seen.add(key);

        if (isExcluded(e.summary)) { skip(e, 'matches ICAL_EXCLUDE'); continue; }
        if (useGuestFilter && hasExternalAttendee(e)) { skip(e, 'has attendee outside FAMILY_DOMAIN'); continue; }

        events.push({
          summary:  e.summary  || '(No title)',
          location: e.location || '',
          start:    start.toISOString(),
          end:      end ? end.toISOString() : null,
          allDay:   ev.datetype === 'date',
        });
      }
    }
  }

  events.sort((a, b) => new Date(a.start) - new Date(b.start));

  if (debug) {
    return res.status(200).json({
      sources: results.map(r => ({ name: r.name, items: Object.keys(r.data).length })),
      events, skipped: skipped.filter(x => !/Holiday|Daylight|Eve$/.test(x.summary || '')).slice(0, 80),
    });
  }
  res.status(200).json({ events, updated: now.toISOString() });
};
