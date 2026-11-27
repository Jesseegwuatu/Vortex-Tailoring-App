// api/bulk-tailor.js
import { jsonOk, jsonError, extractJobFromUrl, tailorResume } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return jsonError(res, 405, 'POST required');

  const { resumeText, jobs } = req.body || {};
  if (!resumeText) return jsonError(res, 400, 'resumeText required');
  if (!Array.isArray(jobs) || !jobs.length) return jsonError(res, 400, 'jobs array required');
  if (jobs.length > 30) return jsonError(res, 400, 'Max 30 jobs per batch.');

  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    let jd = (job.jd || '').trim();

    if (!jd && job.url) {
      try {
        jd = await extractJobFromUrl(job.url);
      } catch (e) {
        /* ignore */
      }
    }

    if (!jd) {
      results.push({ url: job.url, status: 'failed', error: 'Could not extract job description.' });
      continue;
    }

    try {
      const { model, tailored } = await tailorResume(resumeText, jd);
      results.push({
        url: job.url,
        status: 'completed',
        model,
        tailored,
        jobDescription: jd.slice(0, 500),
      });
    } catch (e) {
      results.push({ url: job.url, status: 'failed', error: e.detail || e.message });
    }

    if (i < jobs.length - 1) await new Promise((r) => setTimeout(r, 1200));
  }

  return jsonOk(res, { success: true, results });
}