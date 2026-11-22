/*
 * GET /api/photos
 *
 * Returns thumbnail URLs for images in a OneDrive folder and its subfolders
 * (up to 4 levels deep, 60 folders, 2000 photos).
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
    const select = '?$select=id,name,file,folder&$expand=thumbnails($select=large)&$top=1000';

    const photos = [];
    const debugPages = [];
    const MAX_PHOTOS = 2000, MAX_FOLDERS = 60, MAX_DEPTH = 4;
    let foldersRead = 0;

    // Walk the folder and its subfolders (breadth-first, depth/size capped).
    let queue = folders.map(f => ({
      url: `${GRAPH}/me/drive/root:/${f.split('/').map(encodeURIComponent).join('/')}:/children${select}`,
      depth: 0,
    }));

    while (queue.length && photos.length < MAX_PHOTOS && foldersRead < MAX_FOLDERS) {
      const { url, depth } = queue.shift();
      let nextUrl = url;
      foldersRead++;

      while (nextUrl && photos.length < MAX_PHOTOS) {
        const r = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        const body = await r.json();

        if (req.query.debug === '1') debugPages.push({ status: r.status, body });
        if (!r.ok) {
          // The top folder failing is fatal; a bad subfolder is just skipped.
          if (depth === 0) throw new Error(`Graph API ${r.status}: ${body.error?.message || JSON.stringify(body)}`);
          break;
        }

        for (const item of body.value || []) {
          if (item.folder && depth < MAX_DEPTH) {
            queue.push({ url: `${GRAPH}/me/drive/items/${item.id}/children${select}`, depth: depth + 1 });
          } else if (item.file && /^image\//i.test(item.file.mimeType)) {
            const t = item.thumbnails?.[0]?.large?.url;
            if (t) photos.push(t);
          }
        }

        nextUrl = body['@odata.nextLink'] || null;
      }
    }

    if (req.query.debug === '1') {
      return res.status(200).json({ folder, total: photos.length, foldersRead, pages: debugPages });
    }

    res.status(200).json({ photos });
  } catch (err) {
    res.status(200).json({ photos: [], error: err.message });
  }
};
