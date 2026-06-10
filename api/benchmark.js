const https = require('https');

function groqRequest(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error('Invalid JSON from Groq')); }
      });
    });
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

  const { giro, pais } = req.body || {};

  if (!giro) return res.status(400).json({ error: 'giro requerido' });
  if (!process.env.GROQ_API_KEY)
    return res.status(500).json({ error: 'GROQ_API_KEY no configurada' });

  const paisNombre = pais === 'ES' ? 'España' : 'México';

  const systemPrompt = `Eres un analista financiero experto en benchmarks sectoriales para PyMEs en ${paisNombre}. Responde SOLO con JSON válido, sin texto extra ni markdown.`;

  const userPrompt = `Genera benchmarks financieros típicos para PyMEs del sector "${giro}" en ${paisNombre}.
Responde con este JSON exacto (valores numéricos sin símbolo % ni unidades):
{
  "sector": "nombre descriptivo del sector",
  "fuente": "Estimación interna basada en datos PyME ${paisNombre} — referencia orientativa, no dato oficial",
  "benchmarks": {
    "margenBruto":  {"min": 0, "med": 0, "max": 0, "unit": "%"},
    "margenEbitda": {"min": 0, "med": 0, "max": 0, "unit": "%"},
    "margenNeto":   {"min": 0, "med": 0, "max": 0, "unit": "%"},
    "diasCobro":    {"min": 0, "med": 0, "max": 0, "unit": "días"},
    "diasPago":     {"min": 0, "med": 0, "max": 0, "unit": "días"},
    "score":        {"min": 0, "med": 0, "max": 0, "unit": "pts"}
  },
  "insights": ["insight 1 breve", "insight 2 breve", "insight 3 breve"]
}`;

  try {
    const result = await groqRequest({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      max_tokens: 600,
      temperature: 0.15,
    });

    if (result.status !== 200) {
      console.error('Groq error:', result.status, JSON.stringify(result.body));
      return res.status(502).json({ error: 'Error del servicio IA' });
    }

    const raw = result.body.choices?.[0]?.message?.content?.trim() || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(502).json({ error: 'Respuesta IA no estructurada' });

    const data = JSON.parse(match[0]);
    return res.status(200).json(data);
  } catch (err) {
    console.error('Benchmark handler error:', err?.message || err);
    return res.status(502).json({ error: 'Servicio no disponible temporalmente' });
  }
};
