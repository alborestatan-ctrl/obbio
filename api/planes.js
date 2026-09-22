// /api/planes.js — los planes tal como están en Stripe, no como los escribí yo.
//
// La página de registro pide esto al cargar. El nombre, la descripción y el
// importe salen del catálogo de Stripe en vivo, así que si alguien cambia un
// precio en el dashboard, la página lo refleja sin tocar código y sin riesgo
// de que muestre un número distinto al que se va a cobrar.
//
// Solo devuelve datos que el cliente vería igual en la pantalla de pago.
// La llave secreta se usa del lado del servidor y nunca sale de aquí.

const https = require('https');

// Los price_id NO son secretos — son números de catálogo. Se pueden sobreescribir
// desde Vercel si algún día se crea un precio nuevo.
const PLANES = [
  { clave: 'starter',    price: process.env.STRIPE_PRICE_STARTER    || 'price_1U8oFnIqAU0fOm3NrcXA1hRo' },
  { clave: 'prefounder', price: process.env.STRIPE_PRICE_PREFOUNDER || 'price_1UIZJDIqAU0fOm3NvuSJacLY' },
  { clave: 'cfo',        price: process.env.STRIPE_PRICE_CFO        || 'price_1UIZWEIqAU0fOm3Nh5l5AiRH' },
];

function stripeGet(path, key) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com', path, method: 'GET',
      headers: { 'Authorization': `Bearer ${key}` },
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

// Stripe entrega los importes en la unidad mínima (centavos) salvo en monedas
// sin decimales, como el yen. Se formatea en es-MX, que es el público de Obbio.
const SIN_DECIMALES = new Set(['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','ugx','vnd','vuv','xaf','xof','xpf']);

function montoLegible(unitAmount, currency) {
  if (unitAmount == null) return null;
  const cur = String(currency || 'mxn').toLowerCase();
  const valor = SIN_DECIMALES.has(cur) ? unitAmount : unitAmount / 100;
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency', currency: cur.toUpperCase(), maximumFractionDigits: 0,
    }).format(valor);
  } catch { return `$${Math.round(valor).toLocaleString('es-MX')}`; }
}

function periodoLegible(rec) {
  if (!rec) return '';
  const n = rec.interval_count || 1;
  const unidad = { day: 'día', week: 'semana', month: 'mes', year: 'año' }[rec.interval] || rec.interval;
  if (n === 1) return unidad === 'mes' ? 'al mes' : `al ${unidad}`;
  return `cada ${n} ${unidad}${n > 1 ? 's' : ''}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(200).json({ planes: [], motivo: 'sin_configurar' });

  // expand[]=product trae nombre y descripción en la misma llamada.
  const resultados = await Promise.all(PLANES.map(async (p) => {
    try {
      const r = await stripeGet(`/v1/prices/${encodeURIComponent(p.price)}?expand[]=product`, key);
      if (r.status !== 200 || !r.body?.id) {
        console.error('[planes]', p.clave, r.status, JSON.stringify(r.body).slice(0, 200));
        return null;
      }
      const pr = r.body;
      if (pr.active === false) return null;
      const prod = pr.product || {};
      return {
        clave: p.clave,
        nombre: prod.name || p.clave,
        descripcion: prod.description || '',
        beneficios: Array.isArray(prod.marketing_features)
          ? prod.marketing_features.map(f => f.name).filter(Boolean) : [],
        monto: montoLegible(pr.unit_amount, pr.currency),
        periodo: periodoLegible(pr.recurring),
        orden: pr.unit_amount ?? 0,
      };
    } catch (e) {
      console.error('[planes]', p.clave, e?.message || e);
      return null;
    }
  }));

  const planes = resultados.filter(Boolean).sort((a, b) => a.orden - b.orden);

  // 5 minutos de caché en el borde: el catálogo casi nunca cambia y así la
  // pantalla de registro no depende de una llamada a Stripe en cada visita.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  return res.status(200).json({ planes });
};
