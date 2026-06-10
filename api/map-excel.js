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

  const { sheets } = req.body || {};
  if (!sheets || !sheets.length) return res.status(400).json({ error: 'sheets requerido' });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY no configurada' });

  // Build compact text representation
  const sheetText = sheets.map(s => {
    const rowsText = s.rows.slice(0, 35).map(row =>
      row.slice(0, 8).map(c => {
        const v = (c === null || c === undefined || c === '') ? '' : String(c);
        return v.length > 28 ? v.slice(0, 26) + '..' : v;
      }).join(' | ')
    ).filter(r => r.replace(/\|/g, '').trim()).join('\n');
    return `=== HOJA: "${s.name}" ===\n${rowsText}`;
  }).join('\n\n');

  const systemPrompt = `Eres un experto en contabilidad y estados financieros. Extraes cifras financieras de cualquier Excel, en cualquier idioma o formato. Responde SOLO con JSON válido, sin texto ni markdown.`;

  const userPrompt = `Extrae las cifras financieras más recientes de este Excel y mapéalas al esquema estándar:

${sheetText}

Devuelve este JSON (usa null si no encontraste el dato; números puros sin $ ni comas):
{
  "year": null,
  "empresa": null,
  "ventas": null,
  "cogs": null,
  "gadmin": null,
  "gventas": null,
  "dep": null,
  "gfin": null,
  "caja": null,
  "cxc": null,
  "inventario": null,
  "activo_fijo": null,
  "pasivo_cp": null,
  "pasivo_lp": null,
  "cxp": null,
  "capital": null,
  "notas": "qué encontraste y qué no"
}

Mapeo de conceptos (cualquier idioma):
- ventas = ingresos / net sales / revenue / facturación / total ventas
- cogs = costo de ventas / cost of goods sold / cost of revenue / coût des ventes
- gadmin = gastos admin / SG&A admin / administrative expenses / frais généraux
- gventas = gastos ventas / selling expenses / marketing / comercialización
- dep = depreciación / depreciation / amortisation
- gfin = gastos financieros / interest expense / financial costs / frais financiers
- caja = efectivo + bancos / cash / trésorerie
- cxc = cuentas por cobrar / accounts receivable / debtors / créances clients
- inventario = inventarios / inventory / stock / existencias
- activo_fijo = activo fijo neto / PP&E net / fixed assets / immobilisations nettes
- pasivo_cp = pasivo corto plazo / current liabilities / dettes court terme
- pasivo_lp = pasivo largo plazo / long-term debt / dettes long terme
- cxp = cuentas por pagar / accounts payable / creditors / fournisseurs
- capital = capital contable / equity / patrimonio / capitaux propres
Si hay múltiples años, usa siempre el más reciente. Si los valores son mensuales, suma para obtener el anual.`;

  try {
    const result = await groqRequest({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      max_tokens: 450,
      temperature: 0.1,
    });

    if (result.status !== 200) {
      console.error('Groq error:', result.status, JSON.stringify(result.body));
      return res.status(502).json({ error: 'Error del servicio IA' });
    }

    const raw = result.body.choices?.[0]?.message?.content?.trim() || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(502).json({ error: 'Respuesta IA no estructurada' });

    return res.status(200).json(JSON.parse(match[0]));
  } catch (err) {
    console.error('map-excel error:', err?.message || err);
    return res.status(502).json({ error: 'Servicio no disponible' });
  }
};
