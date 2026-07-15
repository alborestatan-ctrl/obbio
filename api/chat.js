const https = require('https');

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

function groqRequest(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { reject(new Error('Invalid JSON from Groq')); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ error: 'Variables de entorno no configuradas' });

  const callerJwt = (req.headers.authorization || '').replace('Bearer ', '');
  const isAuthed = await verifyUser(callerJwt);
  if (!isAuthed) return res.status(401).json({ error: 'No autorizado' });

  const { question, financialContext, history = [] } = req.body || {};

  if (!question || typeof question !== 'string' || question.length > 600)
    return res.status(400).json({ error: 'Pregunta inválida' });
  if (!financialContext)
    return res.status(400).json({ error: 'Falta contexto financiero' });
  if (!process.env.GROQ_API_KEY)
    return res.status(500).json({ error: 'GROQ_API_KEY no configurada en Vercel' });

  const messages = [
    { role: 'system', content: financialContext },
    ...history.slice(-6).filter(m => m.role === 'user' || m.role === 'assistant'),
    { role: 'user', content: question },
  ];

  try {
    const result = await groqRequest({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 450,
      temperature: 0.35,
    });

    if (result.status !== 200) {
      console.error('Groq error:', result.status, JSON.stringify(result.body));
      return res.status(502).json({ error: 'Error del servicio de IA' });
    }

    const text = result.body.choices?.[0]?.message?.content?.trim()
      || 'No pude generar una respuesta. Intenta de nuevo.';

    return res.status(200).json({ text });
  } catch (err) {
    console.error('Handler error:', err?.message || err);
    return res.status(502).json({ error: 'Servicio de IA no disponible temporalmente' });
  }
};
