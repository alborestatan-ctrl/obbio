const https = require('https');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { question, financialContext, history = [] } = body;

  if (!question || typeof question !== 'string' || question.length > 2000) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Pregunta inválida' }) };
  }
  if (!financialContext) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Falta contexto financiero' }) };
  }
  if (!process.env.GROQ_API_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GROQ_API_KEY no configurada' }) };
  }

  const messages = [
    { role: 'system', content: financialContext },
    ...history.slice(-12).filter(m => m.role === 'user' || m.role === 'assistant'),
    { role: 'user', content: question },
  ];

  try {
    const result = await groqRequest({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 2048,
      temperature: 0.5,
      top_p: 0.9,
    });

    if (result.status !== 200) {
      console.error('Groq error:', result.status, JSON.stringify(result.body));
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Error del servicio de IA' }) };
    }

    const text = result.body.choices?.[0]?.message?.content?.trim()
      || 'No pude generar una respuesta. Intenta de nuevo.';

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ text }) };

  } catch (err) {
    console.error('Handler error:', err?.message || err);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Servicio de IA no disponible temporalmente' }) };
  }
};
    
