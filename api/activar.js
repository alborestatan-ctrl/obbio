// /api/activar.js — a donde Stripe devuelve al cliente después de pagar.
// Comprueba contra Stripe que el pago existe y está cobrado, crea la cuenta y
// redirige a la pantalla "Crea tu contraseña". Sin correo de por medio: el
// cliente nunca sale del navegador.
//
// La confianza viene de consultarle a Stripe por el session_id, no de lo que
// traiga la URL: un session_id inventado no devuelve una sesión pagada.

const https = require('https');

function pedir(hostname, path, method, headers, data) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname, path, method, headers: h }, (res) => {
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

const stripeGet = (path, key) =>
  pedir('api.stripe.com', path, 'GET', { 'Authorization': `Bearer ${key}` }, null);

const supabase = (path, method, body, srk) =>
  pedir(new URL(process.env.SUPABASE_URL).hostname, path, method,
    { 'Content-Type': 'application/json', 'apikey': srk, 'Authorization': `Bearer ${srk}` },
    body ? JSON.stringify(body) : null);

// Precrear la fila en `empresas` y dejar anotada la suscripción, para que el
// webhook pueda encontrar al cliente cuando Stripe avise de una cancelación.
async function precrearEmpresa(userId, srk, stripeInfo) {
  if (!userId) return;
  const r = await supabase('/rest/v1/empresas', 'POST', {
    user_id: userId,
    nombre: 'Sin nombre',
    data: {
      config: {
        plan: stripeInfo?.plan || 'basico',
        modulosVisibles: null,
        moneda: null,
        ivaTasa: null,
        umbrales: { margenEbitdaMin: null, razCorrienteMin: null, debtEbitdaMax: null, dsoMax: null },
      },
      stripe: stripeInfo || null,
    },
    updated_at: new Date().toISOString(),
  }, srk);
  if (r.status !== 200 && r.status !== 201)
    console.error('[activar] no se pudo precrear empresas:', r.status, r.body);
}

// Pantalla de error legible: quien llega aquí acaba de pagar y merece saber qué pasó.
function errorHtml(res, titulo, detalle) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Obbio</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#070810;color:#E8EAF0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
 .c{max-width:420px;text-align:center;background:#10121B;border:1px solid #232739;
    border-radius:18px;padding:40px 32px}
 h1{font-size:20px;margin:0 0 10px}
 p{color:#969DB0;font-size:14px;line-height:1.6;margin:0 0 22px}
 a{display:inline-block;background:#22C55E;color:#fff;text-decoration:none;
   padding:12px 22px;border-radius:10px;font-weight:700;font-size:14px}
</style>
<div class="c"><h1>${titulo}</h1><p>${detalle}</p>
<a href="${process.env.APP_URL || '/'}">Volver a Obbio</a></div>`);
}

module.exports = async (req, res) => {
  const sessionId = String((req.query || {}).session_id || '');
  const key = process.env.STRIPE_SECRET_KEY;
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!sessionId.startsWith('cs_'))
    return errorHtml(res, 'Falta la referencia del pago', 'Abre de nuevo el enlace que te dio Stripe al terminar de pagar.');
  if (!key || !srk || !process.env.SUPABASE_URL)
    return errorHtml(res, 'Configuración incompleta', 'El cobro no está terminado de conectar. Avísanos y lo resolvemos.');

  // 1 · Confirmar contra Stripe que esta sesión existe y está pagada.
  const s = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, key);
  if (s.status !== 200)
    return errorHtml(res, 'No encontramos ese pago', 'Si el cargo sí se hizo, escríbenos y lo activamos a mano.');

  const ses = s.body;
  const pagado = ses.payment_status === 'paid' || ses.payment_status === 'no_payment_required';
  if (ses.status !== 'complete' || !pagado)
    return errorHtml(res, 'El pago no se completó', 'No se hizo ningún cargo. Puedes intentarlo otra vez cuando quieras.');

  const email = String(ses.customer_details?.email || ses.customer_email || ses.client_reference_id || '')
    .trim().toLowerCase();
  if (!email)
    return errorHtml(res, 'Falta el correo', 'El pago se registró pero no traía correo. Escríbenos y lo activamos a mano.');

  const stripeInfo = {
    customer_id: ses.customer || null,
    subscription_id: ses.subscription || null,
    plan: ses.metadata?.plan || null,
    estado: 'activa',
    desde: new Date().toISOString(),
  };

  // 2 · Crear la cuenta y pedir el link para que ponga su contraseña.
  const appUrl = process.env.APP_URL || (req.headers.host ? 'https://' + req.headers.host : '');
  const cuerpo = (tipo) => {
    const b = { type: tipo, email };
    if (appUrl) b.redirect_to = appUrl;
    return b;
  };

  let tipo = 'invite';
  let link = await supabase('/auth/v1/admin/generate_link', 'POST', cuerpo(tipo), srk);

  // Ya existía (por ejemplo, volvió a abrir este mismo enlace): un link de
  // recuperación lleva a la misma pantalla, así que sirve igual.
  if (link.status === 422 || link.status === 400) {
    tipo = 'recovery';
    link = await supabase('/auth/v1/admin/generate_link', 'POST', cuerpo(tipo), srk);
  }

  const actionLink = link.body?.action_link || link.body?.properties?.action_link;
  if (link.status >= 300 || !actionLink) {
    console.error('[activar] generate_link:', link.status, JSON.stringify(link.body).slice(0, 300));
    return errorHtml(res, 'Tu pago quedó registrado',
      'No pudimos abrir la pantalla para crear tu contraseña. Escríbenos con este correo y te damos acceso hoy mismo: ' + email);
  }

  if (tipo === 'invite') {
    const userId = link.body?.id || link.body?.user?.id || null;
    await precrearEmpresa(userId, srk, stripeInfo);
  }

  // 3 · Directo a "Crea tu contraseña".
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(302, { Location: actionLink });
  return res.end();
};
