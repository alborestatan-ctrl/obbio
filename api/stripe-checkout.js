// /api/stripe-checkout.js — abre el pago de la suscripción mensual.
// Público a propósito: es la puerta de entrada de quien todavía no tiene cuenta.
// No crea nada en Supabase; la cuenta se crea en /api/activar, y solo si pagó.

const https = require('https');

// La API de Stripe es form-encoded, no JSON. Los objetos anidados van con
// notación de corchetes: line_items[0][price].
function formEncode(obj, prefix) {
  const partes = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const clave = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') partes.push(formEncode(v, clave));
    else partes.push(`${encodeURIComponent(clave)}=${encodeURIComponent(String(v))}`);
  }
  return partes.join('&');
}

function stripeReq(path, method, params, key) {
  return new Promise((resolve, reject) => {
    const data = params ? formEncode(params) : '';
    const headers = {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'api.stripe.com', path, method, headers }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const key = process.env.STRIPE_SECRET_KEY;
  const price = process.env.STRIPE_PRICE_ID;
  if (!key || !price)
    return res.status(500).json({ error: 'El cobro aún no está configurado. Escríbenos y te damos acceso.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String((body || {}).email || '').trim().toLowerCase();

  if (!EMAIL_RE.test(email) || email.length > 320)
    return res.status(400).json({ error: 'Escribe un correo válido.' });

  const appUrl = process.env.APP_URL
    || (req.headers.host ? 'https://' + req.headers.host : '');

  // {CHECKOUT_SESSION_ID} lo sustituye Stripe al redirigir — va literal, sin escapar.
  const sesion = await stripeReq('/v1/checkout/sessions', 'POST', {
    mode: 'subscription',
    line_items: { 0: { price, quantity: 1 } },
    customer_email: email,
    client_reference_id: email,
    locale: 'es',
    success_url: `${appUrl}/api/activar?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/#registro`,
    subscription_data: { metadata: { app: 'obbio', email } },
    metadata: { app: 'obbio', email },
  }, key);

  if (sesion.status !== 200 || !sesion.body?.url) {
    console.error('[stripe-checkout]', sesion.status, JSON.stringify(sesion.body).slice(0, 400));
    return res.status(502).json({ error: 'No se pudo abrir el pago. Intenta de nuevo.' });
  }

  return res.status(200).json({ url: sesion.body.url });
};
