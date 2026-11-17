/*
 * GET /api/photos
 *
 * Returns direct thumbnail URLs for images in a public OneDrive shared folder.
 *
 * SETUP
 *   1. In OneDrive, right-click your photos folder → Share →
 *      "Anyone with the link can view" → Copy link
 *   2. Add the copied URL as ONEDRIVE_PHOTOS_URL in Vercel env vars
 *
 * Returns { photos: [url, ...] }  — empty array if not configured or on error.
 */

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

  const shareUrl = process.env.ONEDRIVE_PHOTOS_URL;
  if (!shareUrl) return res.status(200).json({ photos: [] });

  try {
    // Encode the share URL as a OneDrive sharing token
    const shareId = 'u!' + Buffer.from(shareUrl)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    const apiUrl =
      `https://api.onedrive.com/v1.0/shares/${shareId}/root/children` +
      `?select=name,file&expand=thumbnails(select=large)`;

    const r = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`OneDrive API ${r.status}`);

    const data = await r.json();

    const photos = (data.value || [])
      .filter(item => item.file && /^image\//i.test(item.file.mimeType))
      .map(item => item.thumbnails?.[0]?.large?.url)
      .filter(Boolean);

    res.status(200).json({ photos });
  } catch (err) {
    res.status(200).json({ photos: [], error: err.message });
  }
};
