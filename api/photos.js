/*
 * GET /api/photos
 *
 * Returns thumbnail URLs for images in a OneDrive folder and its subfolders
 * (up to 4 levels deep, 60 folders), returning a random sample of 300.
 *
 * Required env vars (obtain via scripts/get-onedrive-token.js):
 *   ONEDRIVE_CLIENT_ID      — Azure app registration client ID
 *   ONEDRIVE_CLIENT_SECRET  — Azure app registration client secret
 *   ONEDRIVE_REFRESH_TOKEN  — Long-lived refresh token from OAuth flow
 *   ONEDRIVE_FOLDER         — Folder name in OneDrive (default: "Family Dashboard Photos");
 *                             several folders can be comma-separated
 *
 * Returns { photos: [url, ...] } — empty array if not configured or on error.
 * Add ?debug=1 to see the raw API response for troubleshooting.
 */

const TENANT    = 'consumers';
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH     = 'https://graph.microsoft.com/v1.0';

async function getAccessToken(clientId, refreshToken) {
  const params = new URLSearchParams({
    client_id:     clientId,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
    scope:         'Files.Read offline_access',
  });

  const r = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
    signal:  AbortSignal.timeout(8000),
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  return data.access_token;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');

  const clientId     = process.env.ONEDRIVE_CLIENT_ID;
  const refreshToken = process.env.ONEDRIVE_REFRESH_TOKEN;

  if (!clientId || !refreshToken) {
    return res.status(200).json({ photos: [], error: 'OneDrive credentials not configured. Run scripts/get-onedrive-token.js.' });
  }

  // ONEDRIVE_FOLDER may list several folders, one per line or separated by ';'.
  // A single line is split on commas instead (a folder name containing commas
  // needs its own line or a trailing ';'). A line starting with # is ignored,
  // so a folder can be switched off without deleting it.
  const folders = (process.env.ONEDRIVE_FOLDER || 'Family Dashboard Photos').split(/\r?\n|;/).flatMap((f, _, a) => a.length > 1 ? [f] : f.split(',')).map(f => f.trim()).filter(f => f && !f.startsWith('#'));
  const folder = folders.join(', ');

  try {
    const accessToken = await getAccessToken(clientId, refreshToken);

    // Restrict explicitly to the named folder — Files.Read allows broader access,
    // so we always use the specific folder path rather than a root search.
    const select = '?$select=id,file,folder&$top=1000';

    const ids = []; // image item ids; thumbnails are fetched only for the sample
    const debugPages = [];
    const MAX_FOLDERS = 60, MAX_DEPTH = 4, MAX_RETURN = 300, BATCH = 16;
    let foldersRead = 0;

    // Read one folder (all pages). Returns its subfolder URLs; pushes photo URLs.
    async function readFolder({ url, depth }) {
      let nextUrl = url;
      const subs = [];
      while (nextUrl) {
        const r = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(25000),
        });
        const body = await r.json();
        if (!r.ok) {
          // The top folder failing is fatal; a bad subfolder is just skipped.
          if (depth === 0) throw new Error(`Graph API ${r.status}: ${body.error?.message || JSON.stringify(body)}`);
          break;
        }
        let n = 0;
        for (const item of body.value || []) {
          if (item.folder && depth < MAX_DEPTH) {
            subs.push({ url: `${GRAPH}/me/drive/items/${item.id}/children${select}`, depth: depth + 1 });
          } else if (item.file && /^image\//i.test(item.file.mimeType)) {
            ids.push(item.id); n++;
          }
        }
        if (req.query.debug === '1') debugPages.push({ depth, status: r.status, items: (body.value || []).length, photos: n });
        nextUrl = body['@odata.nextLink'] || null;
      }
      return subs;
    }

    // Walk folders breadth-first, a few at a time (sequential reads were far too slow).
    let queue = folders.map(f => ({
      url: `${GRAPH}/me/drive/root:/${f.split('/').map(encodeURIComponent).join('/')}:/children${select}`,
      depth: 0,
    }));
    while (queue.length && foldersRead < MAX_FOLDERS) {
      const batch = queue.splice(0, Math.min(BATCH, MAX_FOLDERS - foldersRead));
      foldersRead += batch.length;
      const subs = await Promise.all(batch.map(readFolder));
      queue.push(...subs.flat());
    }

    // The dashboard only needs a rotating selection: take a random sample so the
    // response stays small however big the library is, then fetch thumbnails for
    // just those (Graph $batch, 20 per call).
    const total = ids.length;
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    ids.length = Math.min(ids.length, MAX_RETURN);

    const photos = [];
    const chunks = [];
    for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
    await Promise.all(chunks.map(async chunk => {
      try {
        const r = await fetch(`${GRAPH}/$batch`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: chunk.map((id, i) => ({
            id: String(i), method: 'GET', url: `/me/drive/items/${id}/thumbnails?select=large`,
          })) }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await r.json();
        for (const x of data.responses || []) {
          const u = x.body?.value?.[0]?.large?.url;
          if (x.status === 200 && u) photos.push(u);
        }
      } catch { /* skip this chunk */ }
    }));

    if (req.query.debug === '1') {
      return res.status(200).json({ folder, found: total, returned: photos.length, foldersRead, pages: debugPages });
    }

    // Never let the CDN keep an empty result for 15 minutes.
    if (!photos.length) res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ photos });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store'); // don't cache failures
    res.status(200).json({ photos: [], error: err.message });
  }
};
