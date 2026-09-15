// /api/chat.js — Copilot CFO Obbio
// Groq (primario) + Gemini (fallback). Contrato de respuesta: { text, provider }
// Front envía: { question, financialContext, history:[{role,content}], provider? }
// provider: 'groq' | 'gemini' | 'auto' (default)

const https = require('https');

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
// llama-3.3-70b-versatile se apagó en Groq el 2026-08-16 y devolvía error en cada
// llamada: por eso el Resumen Obbio dejó de salir. openai/gpt-oss-120b es el
// reemplazo que Groq recomienda en su aviso de baja. Si vuelve a pasar, se puede
// cambiar desde Vercel con la variable GROQ_MODEL, sin tocar el código.
const GROQ_MODEL = process.env.GROQ_MODEL   || 'openai/gpt-oss-120b';
const GEM_MODEL  = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEM_URL    = `https://generativelanguage.googleapis.com/v1beta/models/${GEM_MODEL}:generateContent`;
const TIMEOUT_MS = 25000;
const MAX_TOKENS = 900;
const TEMP       = 0.4;

// ── Supabase auth ──
function supabaseGet(path, token) {
  return new Promise((resolve, reject) => {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const req = https.request({
      hostname: host, path, method: 'GET',
      headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${token}` },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function verifyUser(jwt) {
  if (!jwt) return false;
  const res = await supabaseGet('/auth/v1/user', jwt);
  return res.status === 200;
}

// ── Timeout helper ──
function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

// ── Groq (OpenAI-compatible) ──
async function callGroq({ question, financialContext, history }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY ausente');
  const messages = [];
  if (financialContext) messages.push({ role: 'system', content: financialContext });
  for (const h of (history || [])) {
    if (h && h.content) messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content) });
  }
  messages.push({ role: 'user', content: question });

  const to = withTimeout(TIMEOUT_MS);
  try {
    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: TEMP, max_tokens: MAX_TOKENS }),
      signal: to.signal,
    });
    if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Groq respuesta vacía');
    return text;
  } finally { to.done(); }
}

// ── Gemini (generateContent) ──
async function callGemini({ question, financialContext, history }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY ausente');
  const contents = [];
  for (const h of (history || [])) {
    if (h && h.content) contents.push({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(h.content) }] });
  }
  contents.push({ role: 'user', parts: [{ text: question }] });

  const body = {
    contents,
    generationConfig: { temperature: TEMP, maxOutputTokens: MAX_TOKENS },
  };
  if (financialContext) body.systemInstruction = { parts: [{ text: financialContext }] };

  const to = withTimeout(TIMEOUT_MS);
  try {
    const r = await fetch(GEM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: to.signal,
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
    if (!text) throw new Error('Gemini respuesta vacía');
    return text;
  } finally { to.done(); }
}

// ── Handler ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ error: 'Variables de entorno no configuradas' });

  const callerJwt = (req.headers.authorization || '').replace('Bearer ', '');
  const isAuthed = await verifyUser(callerJwt);
  if (!isAuthed) return res.status(401).json({ error: 'No autorizado' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { question, financialContext = '', history = [], provider = 'auto' } = body || {};

  if (!question || typeof question !== 'string' || question.length > 1200)
    return res.status(400).json({ error: 'Falta "question" o excede límite' });

  const payload = { question, financialContext, history };

  const chain = provider === 'gemini' ? [callGemini]
              : provider === 'groq'   ? [callGroq]
              :                         [callGroq, callGemini];

  const errors = [];
  for (const fn of chain) {
    try {
      const text = await fn(payload);
      return res.status(200).json({ text, provider: fn === callGroq ? 'groq' : 'gemini' });
    } catch (e) {
      console.error(`[chat] ${fn.name} falló:`, e.message);
      errors.push(e.message || String(e));
    }
  }
  return res.status(502).json({ error: 'No se pudo generar respuesta', detail: errors.join(' | ') });
};
