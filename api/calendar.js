const ical = require('node-ical');

/*
 * GET /api/calendar
 *
 * Returns upcoming family calendar events as JSON.
 * Reads iCal feed URLs from environment variables:
 *   ICAL_JARVIS   — secret iCal address for the Jarvis family calendar (preferred)
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

  const sources = [
    { url: process.env.ICAL_JARVIS,   name: 'Jarvis' },
    { url: process.env.ICAL_MARK,     name: 'Mark' },
    { url: process.env.ICAL_MELANIE,  name: 'Melanie' },
    { url: process.env.ICAL_HARRY,    name: 'Harry' },
    { url: process.env.ICAL_CHARLIZE, name: 'Charlize' },
  ].filter(s => s.url);

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

  const results = await Promise.all(fetches);

  const seen = new Set();
  const events = [];

  for (const { data } of results) {
    for (const ev of Object.values(data)) {
      if (ev.type !== 'VEVENT') continue;

      const start = ev.start instanceof Date ? ev.start : new Date(ev.start);
      if (!start || isNaN(start)) continue;
      if (start < now || start > cutoff) continue;
      // Deduplicate before filtering so a filtered event blocks all its duplicates
      const key = (ev.summary || '') + '|' + start.toISOString().slice(0, 16);
      if (seen.has(key)) continue;
      seen.add(key);

      if (isExcluded(ev.summary)) continue;
      if (hasExternalAttendee(ev)) continue;

      const end = ev.end instanceof Date ? ev.end : (ev.end ? new Date(ev.end) : null);

      events.push({
        summary:  ev.summary  || '(No title)',
        location: ev.location || '',
        start:    start.toISOString(),
        end:      end ? end.toISOString() : null,
        allDay:   ev.datetype === 'date',
      });
    }
  }

  events.sort((a, b) => new Date(a.start) - new Date(b.start));

  res.status(200).json({ events, updated: now.toISOString() });
};
