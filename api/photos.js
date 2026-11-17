/*
 * GET /api/photos
 *
 * Returns thumbnail URLs for images in a public OneDrive shared folder.
 *
 * SETUP
 *   1. In OneDrive, right-click your photos folder → Share →
 *      "Anyone with the link can view" → Copy link
 *   2. Add the copied URL as ONEDRIVE_PHOTOS_URL in Vercel env vars
 *
 * Returns { photos: [url, ...] }  — empty array if not configured or on error.
 * Add ?debug=1 to see the raw API response for troubleshooting.
 */

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

  const shareUrl = process.env.ONEDRIVE_PHOTOS_URL;
  if (!shareUrl) return res.status(200).json({ photos: [], error: 'ONEDRIVE_PHOTOS_URL not set' });

  try {
    // Encode the share URL as a Graph API sharing token
    const shareId = 'u!' + Buffer.from(shareUrl)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    const apiUrl =
      `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem/children` +
      `?$select=name,file&$expand=thumbnails($select=large)`;

    const r = await fetch(apiUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    const body = await r.json();

    if (req.query.debug === '1') {
      return res.status(200).json({ status: r.status, body });
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
