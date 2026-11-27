// api/extract-job.js
import { jsonOk, jsonError, extractJobFromUrl } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return jsonError(res, 405, 'POST required');
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) return jsonError(res, 400, 'Valid URL required');
  try {
    const text = await extractJobFromUrl(url);
    return jsonOk(res, { success: true, text, length: text.length });
  } catch (e) {
    return jsonError(res, 502, e.message);
  }
}