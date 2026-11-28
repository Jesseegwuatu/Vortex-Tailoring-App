// api/_lib.js
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const FIREBASE_DB_URL = 'https://vortex-tailoring-app-default-rtdb.firebaseio.com';

// Primary fallback set — OpenRouter allows max 3 items when route: 'fallback'
export const FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'baidu/ernie-5.5-flash-preview:free',
  'google/gemma-4-31b-it:free',
];

// Last-resort router if the 3-model fallback fails entirely
export const LAST_RESORT_MODEL = 'openrouter/free';

/* ---------- JSON helpers ---------- */
export function jsonOk(res, obj) {
  return res.status(200).json(obj);
}
export function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

/* ---------- Auth ---------- */
export async function getCallerRole(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { uid: null, role: null };
  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyDYEBiyJNuttnLDDieWwmaydisV4LZa5ik`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
      }
    );
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
export function isAdmin(role) {
  return role === 'admin' || role === 'super_admin';
}

/* ---------- OpenRouter single call (for extraction fallbacks) ---------- */
export async function callModel(model, prompt, maxTokens = 2000) {
  const r = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
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

/* ---------- HTML → job text ---------- */
export function htmlToJobText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const main = s.match(/<main[\s\S]*?<\/main>/i) || s.match(/<article[\s\S]*?<\/article>/i);
  if (main) s = main[0];
  s = s
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  s = s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
  const lines = s.split('\n');
  const markers =
    /(responsib|requirement|qualification|what you.?ll do|about the role|about you|skills|experience|benefits)/i;
  let start = lines.findIndex((l) => markers.test(l));
  if (start < 0) start = 0;
  const out = lines.slice(start, start + 120).join('\n');
  return out.length > 200 ? out : s.slice(0, 8000);
}

/* ---------- Job extraction ---------- */
export async function extractJobFromUrl(url) {
  if (!url || !/^https?:\/\//.test(url)) throw new Error('Valid URL required');

  let html = '';
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
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
    if (extracted.length < 400) extracted = '';
  }

  if (!extracted && html) {
    try {
      const ai = await callModel(
        FREE_MODELS[0],
        `Extract ONLY the job description and requirements from this HTML. Return plain text, no preamble. If you cannot find a job description, return exactly: NOT_FOUND\n\nHTML:\n${html.slice(
          0,
          14000
        )}`
      );
      if (ai && !ai.includes('NOT_FOUND') && ai.length > 200) extracted = ai.trim();
    } catch (e) {
      console.warn('AI extract failed:', e.message);
    }
  }

  if (!extracted) {
    try {
      const ai = await callModel(
        FREE_MODELS[0],
        `A user pasted this job URL: ${url}\nYou cannot access the web. Write a plausible, generic job description for the role implied by the URL slug. Keep it 300-500 words. Include responsibilities and requirements. Make clear in the first line: "Note: description synthesized from URL slug."`
      );
      if (ai && ai.length > 100) extracted = ai.trim();
    } catch (e) {
      console.warn('AI slug fallback failed:', e.message);
    }
  }

  if (!extracted) throw new Error('Could not extract a job description from that URL. Please paste it manually.');
  return extracted.slice(0, 10000);
}

/* ---------- Tailoring core ---------- */
const TAILOR_SYSTEM_PROMPT = `You are an expert resume tailor. Rewrite the provided resume to better match the job description WITHOUT inventing any facts.

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

const TAILOR_USER_PROMPT = (resumeText, jobDescription) =>
  `RESUME:\n${resumeText}\n\nJOB DESCRIPTION:\n${jobDescription}\n\nTailor. JSON only.`;

function cleanJsonText(raw) {
  return String(raw || '')
    .trim()
    .replace(/^```json/, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();
}

async function callOpenRouterForTailor(payload) {
  const r = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vortex-tailoring-app.vercel.app',
      'X-Title': 'Vortex Tailoring',
    },
    body: JSON.stringify(payload),
  });

  let bodyText = '';
  try {
    bodyText = await r.text();
  } catch {}

  if (!r.ok) {
    const err = new Error(`OpenRouter ${r.status}`);
    err.status = r.status === 429 ? 429 : 502;
    err.detail = bodyText.slice(0, 500);
    throw err;
  }

  let d;
  try {
    d = JSON.parse(bodyText);
  } catch {
    const err = new Error('OpenRouter returned non-JSON body.');
    err.status = 502;
    err.detail = bodyText.slice(0, 500);
    throw err;
  }

  const usedModel = d.model || payload.model || (payload.models && payload.models[0]) || 'unknown';
  const content = cleanJsonText(d.choices?.[0]?.message?.content || '');
  return { usedModel, content };
}

export async function tailorResume(resumeText, jobDescription) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing');
  if (!resumeText || !jobDescription) throw new Error('resumeText and jobDescription required');
  if (resumeText.length > 15000) throw new Error('Resume too long (max 15k chars).');
  if (jobDescription.length > 10000) throw new Error('Job description too long (max 10k chars).');

  const messages = [
    { role: 'system', content: TAILOR_SYSTEM_PROMPT },
    { role: 'user', content: TAILOR_USER_PROMPT(resumeText, jobDescription) },
  ];

  // ---------- Attempt 1: 3-model fallback ----------
  let firstError = null;
  try {
    const payload = {
      models: FREE_MODELS,
      route: 'fallback',
      messages,
      temperature: 0.3,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
    };
    const { usedModel, content } = await callOpenRouterForTailor(payload);
    if (!content) throw new Error('Empty content from 3-model fallback.');
    const tailored = JSON.parse(content);
    return { model: usedModel, tailored };
  } catch (e) {
    firstError = e;
    console.warn('3-model fallback failed:', e.message, e.detail || '');
  }

  // ---------- Attempt 2: openrouter/free last resort ----------
  try {
    const payload = {
      model: LAST_RESORT_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
    };
    const { usedModel, content } = await callOpenRouterForTailor(payload);
    if (!content) throw new Error('Empty content from openrouter/free.');
    const tailored = JSON.parse(content);
    return { model: usedModel, tailored };
  } catch (e) {
    const err = new Error('Tailoring failed on all models.');
    err.status = e.status || firstError?.status || 502;
    err.detail = `primary: ${firstError?.message || 'n/a'} | last resort: ${e.message}`;
    throw err;
  }
}

/* ---------- PDF builder ---------- */
export async function buildResumePdf(data) {
  const pdf = await PDFDocument.create();
  const fontReg = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28,
    H = 841.89,
    MX = 54,
    MT = 54,
    MB = 54;
  const CW = W - MX * 2;
  const burgundy = rgb(0.333, 0.082, 0.184);
  const dark = rgb(0.1, 0.05, 0.08);
  const muted = rgb(0.42, 0.33, 0.38);
  const gold = rgb(0.84, 0.68, 0.38);
  let page = pdf.addPage([W, H]);
  let y = H - MT;
  const space = (n) => {
    if (y - n < MB) {
      page = pdf.addPage([W, H]);
      y = H - MT;
    }
  };
  const wrap = (text, font, size, maxW) => {
    const words = String(text || '').split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(t, size) > maxW && line) {
        lines.push(line);
        line = w;
      } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  };
  const para = (text, opt = {}) => {
    if (!text) return;
    const { font = fontReg, size = 10.5, color = dark, lh = 14, gap = 6 } = opt;
    for (const ln of wrap(text, font, size, CW)) {
      space(lh);
      page.drawText(ln, { x: MX, y: y - size, size, font, color });
      y -= lh;
    }
    y -= gap;
  };
  const head = (t) => {
    if (!t) return;
    space(28);
    y -= 6;
    page.drawText(String(t).toUpperCase(), {
      x: MX,
      y: y - 11,
      size: 11,
      font: fontBold,
      color: burgundy,
    });
    const w = fontBold.widthOfTextAtSize(String(t).toUpperCase(), 11);
    page.drawLine({
      start: { x: MX, y: y - 15 },
      end: { x: MX + w, y: y - 15 },
      thickness: 1.2,
      color: gold,
    });
    y -= 22;
  };
  const bullet = (t) => {
    if (!t) return;
    const lines = wrap(t, fontReg, 10, CW - 14);
    let first = true;
    for (const ln of lines) {
      space(13.5);
      if (first) {
        page.drawText('•', { x: MX + 2, y: y - 10, size: 10, font: fontReg, color: burgundy });
        first = false;
      }
      page.drawText(ln, { x: MX + 14, y: y - 10, size: 10, font: fontReg, color: dark });
      y -= 13.5;
    }
  };
  space(30);
  page.drawText(data.name || 'Your Name', { x: MX, y: y - 22, size: 22, font: fontBold, color: dark });
  y -= 28;
  const contact = [data.email, data.phone, data.location].filter(Boolean).join('   •   ');
  if (contact) {
    for (const ln of wrap(contact, fontReg, 9.5, CW)) {
      space(13);
      page.drawText(ln, { x: MX, y: y - 9, size: 9.5, font: fontReg, color: muted });
      y -= 13;
    }
  }
  y -= 4;
  page.drawLine({ start: { x: MX, y }, end: { x: W - MX, y }, thickness: 1.5, color: gold });
  y -= 14;
  if (data.summary) {
    head('Professional Summary');
    para(data.summary, { gap: 8 });
  }
  if (Array.isArray(data.skills) && data.skills.length) {
    head('Skills');
    para(data.skills.join('  •  '), { size: 10, gap: 8 });
  }
  if (Array.isArray(data.experience))
    for (const e of data.experience) {
      space(20);
      const title = [e.title, e.company].filter(Boolean).join(' — ');
      if (title)
        for (const ln of wrap(title, fontBold, 11, CW - 90)) {
          space(15);
          page.drawText(ln, { x: MX, y: y - 11, size: 11, font: fontBold, color: dark });
          y -= 15;
        }
      if (e.dates) {
        const dw = fontReg.widthOfTextAtSize(e.dates, 9.5);
        page.drawText(e.dates, { x: W - MX - dw, y: y + 15 - 11, size: 9.5, font: fontReg, color: muted });
      }
      y -= 4;
      if (Array.isArray(e.bullets)) for (const b of e.bullets) bullet(b);
      y -= 8;
    }
  if (Array.isArray(data.education) && data.education.length) {
    head('Education');
    for (const e of data.education)
      para([e.degree, e.institution, e.year].filter(Boolean).join('  —  '), { size: 10, gap: 4 });
  }
  return await pdf.save();
}

export function sanitize(n) {
  return (
    String(n)
      .replace(/[\/\\:*?"<>|]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'resume'
  );
}
