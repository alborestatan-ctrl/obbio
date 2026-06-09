const https = require('https');

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
