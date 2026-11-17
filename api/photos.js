/*
 * GET /api/photos
 *
 * Returns thumbnail URLs for images in a OneDrive folder.
 *
 * Required env vars (obtain via scripts/get-onedrive-token.js):
 *   ONEDRIVE_CLIENT_ID      — Azure app registration client ID
 *   ONEDRIVE_CLIENT_SECRET  — Azure app registration client secret
 *   ONEDRIVE_REFRESH_TOKEN  — Long-lived refresh token from OAuth flow
 *   ONEDRIVE_FOLDER         — Folder name in OneDrive (default: "Family Dashboard Photos")
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

  const folder = (process.env.ONEDRIVE_FOLDER || 'Family Dashboard Photos').trim();

  try {
    const accessToken = await getAccessToken(clientId, refreshToken);

    // Restrict explicitly to the named folder — Files.Read allows broader access,
    // so we always use the specific folder path rather than a root search.
    const folderEncoded = folder.split('/').map(encodeURIComponent).join('/');
    const apiUrl =
      `${GRAPH}/me/drive/root:/${folderEncoded}:/children` +
      `?$select=name,file&$expand=thumbnails($select=large)`;

    const r = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    const body = await r.json();

    if (req.query.debug === '1') {
      return res.status(200).json({ status: r.status, folder, body });
    }

    if (!r.ok) throw new Error(`Graph API ${r.status}: ${body.error?.message || JSON.stringify(body)}`);

    const photos = (body.value || [])
      .filter(item => item.file && /^image\//i.test(item.file.mimeType))
      .map(item => item.thumbnails?.[0]?.large?.url)
      .filter(Boolean);

    res.status(200).json({ photos });
  } catch (err) {
    res.status(200).json({ photos: [], error: err.message });
  }
};
