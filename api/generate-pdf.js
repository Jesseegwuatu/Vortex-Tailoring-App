// api/generate-pdf.js
import { jsonError, buildResumePdf, sanitize } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return jsonError(res, 405, 'POST required');

  const { tailored, template } = req.body || {};
  if (!tailored) return jsonError(res, 400, 'tailored required');

  try {
    const bytes = await buildResumePdf(tailored, template || 'classic');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitize(tailored.name || 'resume')}-tailored.pdf"`
    );
    res.setHeader('Content-Length', bytes.length.toString());
    return res.status(200).send(Buffer.from(bytes));
  } catch (e) {
    return jsonError(res, 500, 'PDF failed: ' + e.message);
  }
}