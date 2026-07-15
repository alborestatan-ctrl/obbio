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

const SYSTEM_PROMPT = `Eres un analista financiero especializado en benchmarks sectoriales de PyMEs.
Tu tarea es proporcionar rangos de referencia (mediana del sector) basados en estadísticas oficiales publicadas.

FUENTES AUTORIZADAS:
- México: INEGI Censos Económicos 2019/2024, INEGI EMIM, INEGI ENEC, BANXICO SIE, IMEF, CANIRAC, CANACINTRA
- España: Banco de España Central de Balances (RSE), INE Estadística Estructural de Empresas (EEE), AEAT Estadística IS, ACCID

REGLAS ESTRICTAS:
1. Responde ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown.
2. Los valores deben ser la mediana del sector para empresas con ingresos entre $5M y $500M anuales.
3. Si no tienes datos confiables para un KPI, usa null (no inventes).
4. "fuente" debe ser el nombre exacto de la publicación oficial (ej: "INEGI Censos Económicos 2019, SCIAN 722").
5. "url" debe ser la URL más específica disponible de esa fuente.
6. "metodologia" debe explicar en 1 oración cómo se deriva el número (ej: "Utilidad operativa / Ingresos totales de la tabla de resultados por CNAE").`;

const USER_PROMPT = (giro, pais) => {
  const paisLabel = pais === 'ES' ? 'España' : 'México';
  const fuenteHint = pais === 'ES'
    ? 'Banco de España RSE e INE EEE por CNAE'
    : 'INEGI Censos Económicos por SCIAN y publicaciones sectoriales';
  return `Sector: "${giro}" | País: ${paisLabel}

Busca en tu conocimiento de ${fuenteHint} los ratios medianos para este sector.
Devuelve exactamente este JSON (sin nada más):
{
  "margenEbitda": <% número>,
  "margenNeto": <% número>,
  "razCorriente": <ratio número>,
  "debtEbitda": <veces número>,
  "cobIntereses": <veces número o null>,
  "roe": <% número o null>,
  "dso": <días número o null>,
  "cogsPct": <% del ingreso número o null>,
  "fuente": "<nombre exacto de la publicación oficial y sección>",
  "url": "<URL directa a la fuente oficial>",
  "metodologia": "<cómo se calcula este referente en 1 oración>",
  "cobertura": "<descripción del universo: tamaño de empresa, año, región>"
}`;
};

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

  const { giro, pais } = req.body || {};
  if (!giro || typeof giro !== 'string' || giro.length > 200)
    return res.status(400).json({ error: 'Sector (giro) inválido o faltante' });
  if (!process.env.GROQ_API_KEY)
    return res.status(500).json({ error: 'GROQ_API_KEY no configurada' });

  const paisNorm = (pais === 'ES') ? 'ES' : 'MX';

  try {
    const result = await groqRequest({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT(giro, paisNorm) },
      ],
      max_tokens: 600,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    if (result.status !== 200) {
      console.error('[benchmark] Groq error:', result.status, JSON.stringify(result.body));
      return res.status(502).json({ error: 'Error del servicio IA' });
    }

    const raw = result.body.choices?.[0]?.message?.content?.trim();
    if (!raw) return res.status(502).json({ error: 'Respuesta vacía de IA' });

    let bm;
    try { bm = JSON.parse(raw); } catch { return res.status(502).json({ error: 'IA devolvió JSON inválido' }); }

    // Sanitize: only numeric fields pass through as numbers
    const numOrNull = v => (v !== null && v !== undefined && !isNaN(Number(v))) ? Number(v) : null;
    return res.status(200).json({
      margenEbitda:  numOrNull(bm.margenEbitda),
      margenNeto:    numOrNull(bm.margenNeto),
      razCorriente:  numOrNull(bm.razCorriente),
      debtEbitda:    numOrNull(bm.debtEbitda),
      cobIntereses:  numOrNull(bm.cobIntereses),
      roe:           numOrNull(bm.roe),
      dso:           numOrNull(bm.dso),
      cogsPct:       numOrNull(bm.cogsPct),
      fuente:        typeof bm.fuente === 'string' ? bm.fuente.slice(0,300) : null,
      url:           typeof bm.url === 'string' && bm.url.startsWith('http') ? bm.url.slice(0,500) : null,
      metodologia:   typeof bm.metodologia === 'string' ? bm.metodologia.slice(0,400) : null,
      cobertura:     typeof bm.cobertura === 'string' ? bm.cobertura.slice(0,300) : null,
      _origen: 'ia',
      _modelo: 'llama-3.3-70b',
      _fecha: new Date().getFullYear().toString(),
    });
  } catch (err) {
    console.error('[benchmark] handler error:', err?.message || err);
    return res.status(502).json({ error: 'Servicio no disponible' });
  }
};
