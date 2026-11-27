// api/tailor.js
import { jsonOk, jsonError, tailorResume } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return jsonError(res, 405, 'Method not allowed');

  const { resumeText, jobDescription } = req.body || {};
  try {
    const { model, tailored } = await tailorResume(resumeText, jobDescription);
    return jsonOk(res, { success: true, model, tailored, originalLength: resumeText.length });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message, detail: e.detail });
  }
}