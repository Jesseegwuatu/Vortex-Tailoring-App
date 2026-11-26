// api/index.js
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FIREBASE_DB_URL = 'https://vortex-tailoring-app-default-rtdb.firebaseio.com';

const FREE_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'google/gemini-2.0-flash-exp:free',
  'qwen/qwen-2.5-72b-instruct:free',
];

export default async function handler(req) {
  const url = new URL(req.url, `http://${req.headers.get('host') || 'localhost'}`);
  const path = url.pathname;

  if (path.endsWith('/extract-job')) return handleExtractJob(req);
  if (path.endsWith('/bulk-tailor')) return handleBulkTailor(req);
  if (path.endsWith('/generate-pdf')) return handleGeneratePdf(req);
  return handleTailor(req);
}

/* ============ AUTH: verify Firebase ID token, get role ============ */
async function getCallerRole(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { uid: null, role: null };
  try {
    // Verify token with Firebase Auth REST
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyDYEBiyJNuttnLDDieWwmaydisV4LZa5ik`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });
    if (!r.ok) return { uid: null, role: null };
    const data = await r.json();
    const uid = data.users?.[0]?.localId;
    if (!uid) return { uid: null, role: null };
    const u = await fetch(`${FIREBASE_DB_URL}/users/${uid}/role.json`);
    const role = await u.json();
    return { uid, role };
  } catch {
    return { uid: null, role: null };
  }
}
function isAdmin(role) { return role === 'admin' || role === 'super_admin'; }

/* ============ HANDLER: /api/extract-job ============ */
async function handleExtractJob(req) {
  if (req.method !== 'POST') return jsonError(405, 'POST required');
  let body;
  try { body = await req.json(); } catch { return jsonError(400, 'Invalid JSON'); }
  const { url } = body || {};
  if (!url || !/^https?:\/\//.test(url)) return jsonError(400, 'Valid URL required');

  // 1) Server-side fetch — no CORS
  let html = '';
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (r.ok) html = await r.text();
  } catch (e) {
    console.warn('Direct fetch failed:', e.message);
  }

  let extracted = '';
  if (html) {
    extracted = htmlToJobText(html);
    // If the page is JS-rendered, this will be too short
    if (extracted.length < 400) extracted = '';
  }

  // 2) AI fallback — ask the model to pull the JD out of the raw HTML
  if (!extracted && html) {
    try {
      const ai = await callModel(FREE_MODELS[0], `Extract ONLY the job description and requirements from this HTML. Return plain text, no preamble. If you cannot find a job description, return exactly: NOT_FOUND\n\nHTML:\n${html.slice(0, 14000)}`);
      if (ai && !ai.includes('NOT_FOUND') && ai.length > 200) extracted = ai.trim();
    } catch (e) { console.warn('AI extract failed:', e.message); }
  }

  // 3) AI without HTML — ask model to guess the JD from the URL path
  if (!extracted) {
    try {
      const ai = await callModel(FREE_MODELS[0], `A user pasted this job URL: ${url}\nYou cannot access the web. Write a plausible, generic job description for the role implied by the URL slug (e.g. /jobs/senior-react-developer → Senior React Developer). Keep it 300-500 words. Include responsibilities and requirements. Make clear in the first line: "Note: description synthesized from URL slug."`);
      if (ai && ai.length > 100) extracted = ai.trim();
    } catch (e) { console.warn('AI slug fallback failed:', e.message); }
  }

  if (!extracted) return jsonError(502, 'Could not extract a job description from that URL. Please paste it manually.');
  return jsonOk({ success: true, text: extracted.slice(0, 10000), length: extracted.length });
}

function htmlToJobText(html) {
  // Remove scripts/styles
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  // Prefer <main>, <article>
  const main = s.match(/<main[\s\S]*?<\/main>/i) || s.match(/<article[\s\S]*?<\/article>/i);
  if (main) s = main[0];
  // Strip tags
  s = s.replace(/<[^>]+>/g, '\n')
       .replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'");
  // Collapse
  s = s.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n');
  // Filter blocks likely to be job description (headings like Responsibilities, Requirements)
  const lines = s.split('\n');
  const markers = /(responsib|requirement|qualification|what you.?ll do|about the role|about you|skills|experience|benefits)/i;
  let start = lines.findIndex(l => markers.test(l));
  if (start < 0) start = 0;
  const out = lines.slice(start, start + 120).join('\n');
  return out.length > 200 ? out : s.slice(0, 8000);
}

async function callModel(model, prompt, maxTokens = 2000) {
  const r = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vortex-tailoring-app.vercel.app',
      'X-Title': 'Vortex Tailoring',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}

/* ============ HANDLER: /api/tailor ============ */
async function handleTailor(req) {
  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');
  if (!OPENROUTER_API_KEY) return jsonError(500, 'OPENROUTER_API_KEY missing');
  let body; try { body = await req.json(); } catch { return jsonError(400, 'Invalid JSON'); }
  const { resumeText, jobDescription } = body || {};
  if (!resumeText || !jobDescription) return jsonError(400, 'resumeText and jobDescription required');
  if (resumeText.length > 15000) return jsonError(400, 'Resume too long (max 15k chars).');
  if (jobDescription.length > 10000) return jsonError(400, 'Job description too long (max 10k chars).');

  const systemPrompt = `You are an expert resume tailor. Rewrite the provided resume to better match the job description WITHOUT inventing any facts.

Rules:
1. ONLY rephrase, reorder, and emphasize existing content.
2. Use keywords from the job description ONLY if truthful to the original.
3. Do NOT add new skills, jobs, certifications, or projects.
4. Output MUST be valid JSON, no markdown fences:
{
  "name": "", "email": "", "phone": "", "location": "",
  "summary": "2-3 sentences",
  "skills": [],
  "experience": [ { "title": "", "company": "", "dates": "", "bullets": [] } ],
  "education": [ { "degree": "", "institution": "", "year": "" } ]
}
5. Return ONLY the raw JSON object.`;

  let lastError = null;
  for (const model of FREE_MODELS) {
    try {
      const r = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://vortex-tailoring-app.vercel.app',
          'X-Title': 'Vortex Tailoring',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `RESUME:\n${resumeText}\n\nJOB DESCRIPTION:\n${jobDescription}\n\nTailor. JSON only.` },
          ],
          temperature: 0.3,
          max_tokens: 4000,
        }),
      });
      if (!r.ok) { lastError = `${model}: ${r.status}`; continue; }
      const d = await r.json();
      let content = d.choices?.[0]?.message?.content || '';
      content = content.trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
      let tailored;
      try { tailored = JSON.parse(content); } catch { lastError = `${model}: bad JSON`; continue; }
      return jsonOk({ success: true, model, tailored, originalLength: resumeText.length });
    } catch (e) {
      lastError = `${model}: ${e.message}`;
    }
  }
  return new Response(JSON.stringify({ error: 'All free models unavailable.', detail: lastError }), {
    status: 429, headers: { 'Content-Type': 'application/json' },
  });
}

/* ============ HANDLER: /api/bulk-tailor ============ */
async function handleBulkTailor(req) {
  if (req.method !== 'POST') return jsonError(405, 'POST required');
  if (!OPENROUTER_API_KEY) return jsonError(500, 'OPENROUTER_API_KEY missing');
  let body; try { body = await req.json(); } catch { return jsonError(400, 'Invalid JSON'); }
  const { resumeText, jobs } = body || {}; // jobs = [{url, jd?}]
  if (!resumeText) return jsonError(400, 'resumeText required');
  if (!Array.isArray(jobs) || !jobs.length) return jsonError(400, 'jobs array required');
  if (jobs.length > 30) return jsonError(400, 'Max 30 jobs per batch.');

  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    let jd = (job.jd || '').trim();
    // If no JD provided, extract from URL server-side
    if (!jd && job.url) {
      try {
        const ex = await handleExtractJob(new Request('http://x/extract-job', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: job.url }),
        }));
        const exData = await ex.json();
        if (exData.success) jd = exData.text;
      } catch (e) { /* ignore */ }
    }
    if (!jd) {
      results.push({ url: job.url, status: 'failed', error: 'Could not extract job description.' });
      continue;
    }
    // Tailor
    try {
      // Reuse handleTailor logic inline
      const sys = `You are an expert resume tailor. Only rephrase existing content. Output valid JSON with keys name, email, phone, location, summary, skills, experience[{title,company,dates,bullets}], education[{degree,institution,year}]. No markdown fences.`;
      let tailored = null, usedModel = null, lastErr = null;
      for (const model of FREE_MODELS) {
        try {
          const r = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://vortex-tailoring-app.vercel.app',
              'X-Title': 'Vortex Tailoring',
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: `RESUME:\n${resumeText}\n\nJD:\n${jd}\n\nJSON only.` },
              ],
              temperature: 0.3, max_tokens: 4000,
            }),
          });
          if (!r.ok) { lastErr = `${model} ${r.status}`; continue; }
          const d = await r.json();
          let c = (d.choices?.[0]?.message?.content || '').trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
          const parsed = JSON.parse(c);
          tailored = parsed; usedModel = model; break;
        } catch (e) { lastErr = `${model} ${e.message}`; }
      }
      if (tailored) {
        results.push({ url: job.url, status: 'completed', model: usedModel, tailored, jobDescription: jd.slice(0, 500) });
      } else {
        results.push({ url: job.url, status: 'failed', error: lastErr || 'All models failed' });
      }
    } catch (e) {
      results.push({ url: job.url, status: 'failed', error: e.message });
    }
    // Small gap between calls to reduce 429s
    if (i < jobs.length - 1) await new Promise(r => setTimeout(r, 1200));
  }

  return jsonOk({ success: true, results });
}

/* ============ HANDLER: /api/generate-pdf ============ */
async function handleGeneratePdf(req) {
  if (req.method !== 'POST') return jsonError(405, 'POST required');
  let body; try { body = await req.json(); } catch { return jsonError(400, 'Invalid JSON'); }
  const { tailored, template } = body || {};
  if (!tailored) return jsonError(400, 'tailored required');
  try {
    const bytes = await buildResumePdf(tailored, template || 'classic');
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${sanitize(tailored.name || 'resume')}-tailored.pdf"`,
        'Content-Length': bytes.length.toString(),
      },
    });
  } catch (e) {
    return jsonError(500, 'PDF failed: ' + e.message);
  }
}

async function buildResumePdf(data) {
  const pdf = await PDFDocument.create();
  const fontReg = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, MX = 54, MT = 54, MB = 54;
  const CW = W - MX * 2;
  const burgundy = rgb(0.333, 0.082, 0.184);
  const dark = rgb(0.1, 0.05, 0.08);
  const muted = rgb(0.42, 0.33, 0.38);
  const gold = rgb(0.84, 0.68, 0.38);
  let page = pdf.addPage([W, H]);
  let y = H - MT;
  const space = (n) => { if (y - n < MB) { page = pdf.addPage([W, H]); y = H - MT; } };
  const wrap = (text, font, size, maxW) => {
    const words = String(text || '').split(/\s+/);
    const lines = []; let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(t, size) > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  };
  const para = (text, opt = {}) => {
    if (!text) return;
    const { font = fontReg, size = 10.5, color = dark, lh = 14, gap = 6 } = opt;
    for (const ln of wrap(text, font, size, CW)) { space(lh); page.drawText(ln, { x: MX, y: y - size, size, font, color }); y -= lh; }
    y -= gap;
  };
  const head = (t) => {
    if (!t) return; space(28); y -= 6;
    page.drawText(String(t).toUpperCase(), { x: MX, y: y - 11, size: 11, font: fontBold, color: burgundy });
    const w = fontBold.widthOfTextAtSize(String(t).toUpperCase(), 11);
    page.drawLine({ start: { x: MX, y: y - 15 }, end: { x: MX + w, y: y - 15 }, thickness: 1.2, color: gold });
    y -= 22;
  };
  const bullet = (t) => {
    if (!t) return;
    const lines = wrap(t, fontReg, 10, CW - 14);
    let first = true;
    for (const ln of lines) {
      space(13.5);
      if (first) { page.drawText('•', { x: MX + 2, y: y - 10, size: 10, font: fontReg, color: burgundy }); first = false; }
      page.drawText(ln, { x: MX + 14, y: y - 10, size: 10, font: fontReg, color: dark });
      y -= 13.5;
    }
  };
  space(30);
  page.drawText(data.name || 'Your Name', { x: MX, y: y - 22, size: 22, font: fontBold, color: dark });
  y -= 28;
  const contact = [data.email, data.phone, data.location].filter(Boolean).join('   •   ');
  if (contact) { for (const ln of wrap(contact, fontReg, 9.5, CW)) { space(13); page.drawText(ln, { x: MX, y: y - 9, size: 9.5, font: fontReg, color: muted }); y -= 13; } }
  y -= 4;
  page.drawLine({ start: { x: MX, y }, end: { x: W - MX, y }, thickness: 1.5, color: gold });
  y -= 14;
  if (data.summary) { head('Professional Summary'); para(data.summary, { gap: 8 }); }
  if (Array.isArray(data.skills) && data.skills.length) { head('Skills'); para(data.skills.join('  •  '), { size: 10, gap: 8 }); }
  if (Array.isArray(data.experience)) for (const e of data.experience) {
    space(20);
    const title = [e.title, e.company].filter(Boolean).join(' — ');
    if (title) for (const ln of wrap(title, fontBold, 11, CW - 90)) { space(15); page.drawText(ln, { x: MX, y: y - 11, size: 11, font: fontBold, color: dark }); y -= 15; }
    if (e.dates) { const dw = fontReg.widthOfTextAtSize(e.dates, 9.5); page.drawText(e.dates, { x: W - MX - dw, y: y + 15 - 11, size: 9.5, font: fontReg, color: muted }); }
    y -= 4;
    if (Array.isArray(e.bullets)) for (const b of e.bullets) bullet(b);
    y -= 8;
  }
  if (Array.isArray(data.education) && data.education.length) {
    head('Education');
    for (const e of data.education) para([e.degree, e.institution, e.year].filter(Boolean).join('  —  '), { size: 10, gap: 4 });
  }
  return await pdf.save();
}

function jsonOk(o) { return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
function jsonError(s, m) { return new Response(JSON.stringify({ error: m }), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function sanitize(n) { return String(n).replace(/[\/\\:*?"<>|]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'resume'; }