// /api/stripe-webhook.js — lo que Stripe le cuenta a Obbio por su cuenta.
// Dos trabajos: red de seguridad del alta (si el cliente cerró la pestaña justo
// después de pagar, la cuenta se crea igual) y ciclo de vida de la suscripción
// (si cancela o deja de pagar, se le retira el acceso; si vuelve, se le devuelve).
//
// NUNCA se lee req.body aquí. Vercel lo expone como getter perezoso que parsea
// el cuerpo, y para validar la firma hace falta el cuerpo EXACTO tal como lo
// mandó Stripe — reserializarlo cambia los bytes y la firma deja de cuadrar.

const https = require('https');
const crypto = require('crypto');

function leerCrudo(req) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    req.on('data', c => trozos.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(trozos)));
    req.on('error', reject);
  });
}

function supabase(path, method, body, srk) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      'apikey': srk,
      'Authorization': `Bearer ${srk}`,
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req2 = https.request({
      hostname: new URL(process.env.SUPABASE_URL).hostname, path, method, headers,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req2.on('error', reject);
    if (data) req2.write(data);
    req2.end();
  });
}

// Firma de Stripe: cabecera "t=<ts>,v1=<hex>"; se firma `${ts}.${cuerpoCrudo}`.
// La tolerancia de 5 minutos evita que alguien reenvíe un evento viejo capturado.
function firmaValida(crudo, cabecera, secreto) {
  if (!cabecera || !secreto) return false;
  const partes = Object.fromEntries(
    String(cabecera).split(',').map(p => {
      const i = p.indexOf('=');
      return i < 0 ? ['', ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  const ts = partes.t;
  const recibida = partes.v1;
  if (!ts || !recibida) return false;

  const edad = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(edad) || edad > 300) return false;

  const esperada = crypto.createHmac('sha256', secreto)
    .update(Buffer.concat([Buffer.from(`${ts}.`), crudo]))
    .digest('hex');

  const a = Buffer.from(esperada, 'utf8');
  const b = Buffer.from(recibida, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Buscar al cliente por lo que traiga el evento de Stripe.
async function buscarEmpresa(srk, { subscriptionId, customerId }) {
  for (const [campo, valor] of [['subscription_id', subscriptionId], ['customer_id', customerId]]) {
    if (!valor) continue;
    const r = await supabase(
      `/rest/v1/empresas?data->stripe->>${campo}=eq.${encodeURIComponent(valor)}&select=id,user_id,data`,
      'GET', null, srk);
    if (r.status === 200 && Array.isArray(r.body) && r.body.length) return r.body[0];
  }
  return null;
}

// Cortar o devolver el acceso. Se hace en Supabase, no en el front: un candado
// que solo vive en el navegador no es un candado.
async function fijarAcceso(srk, empresa, activa, motivo) {
  if (!empresa?.user_id) return;
  await supabase(`/auth/v1/admin/users/${empresa.user_id}`, 'PUT',
    { ban_duration: activa ? 'none' : '876000h' }, srk);

  const data = { ...(empresa.data || {}) };
  data.stripe = { ...(data.stripe || {}), estado: activa ? 'activa' : 'inactiva', motivo: motivo || null,
                  actualizado: new Date().toISOString() };
  await supabase(`/rest/v1/empresas?id=eq.${empresa.id}`, 'PATCH',
    { data, updated_at: new Date().toISOString() }, srk);

  console.log(`[webhook] acceso ${activa ? 'restituido' : 'retirado'} a ${empresa.user_id} (${motivo})`);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const secreto = process.env.STRIPE_WEBHOOK_SECRET;
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secreto || !srk || !process.env.SUPABASE_URL) {
    console.error('[webhook] faltan variables de entorno');
    return res.status(500).json({ error: 'Sin configurar' });
  }

  const crudo = await leerCrudo(req);
  if (!firmaValida(crudo, req.headers['stripe-signature'], secreto)) {
    console.error('[webhook] firma inválida — evento descartado');
    return res.status(400).json({ error: 'Firma inválida' });
  }

  let evento;
  try { evento = JSON.parse(crudo.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Cuerpo ilegible' }); }

  const obj = evento.data?.object || {};

  try {
    switch (evento.type) {
      // Red de seguridad: si cerró la pestaña antes de que /api/activar corriera,
      // la cuenta se crea igual y el admin puede reenviarle el link.
      case 'checkout.session.completed': {
        const email = String(obj.customer_details?.email || obj.customer_email || '').trim().toLowerCase();
        if (!email) break;
        const ya = await buscarEmpresa(srk, { subscriptionId: obj.subscription, customerId: obj.customer });
        if (ya) { console.log('[webhook] la cuenta ya existía:', email); break; }

        const alta = await supabase('/auth/v1/admin/users', 'POST',
          { email, email_confirm: true }, srk);
        if (alta.status === 200 || alta.status === 201) {
          await supabase('/rest/v1/empresas', 'POST', {
            user_id: alta.body.id,
            nombre: 'Sin nombre',
            data: {
              config: { plan: 'basico', modulosVisibles: null, moneda: null, ivaTasa: null,
                        umbrales: { margenEbitdaMin: null, razCorrienteMin: null, debtEbitdaMax: null, dsoMax: null } },
              stripe: { customer_id: obj.customer || null, subscription_id: obj.subscription || null,
                        estado: 'activa', desde: new Date().toISOString() },
            },
            updated_at: new Date().toISOString(),
          }, srk);
          console.log('[webhook] cuenta creada por respaldo:', email);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const empresa = await buscarEmpresa(srk, { subscriptionId: obj.id, customerId: obj.customer });
        if (!empresa) break;
        const viva = obj.status === 'active' || obj.status === 'trialing';
        await fijarAcceso(srk, empresa, viva, 'suscripción ' + obj.status);
        break;
      }

      case 'customer.subscription.deleted': {
        const empresa = await buscarEmpresa(srk, { subscriptionId: obj.id, customerId: obj.customer });
        if (empresa) await fijarAcceso(srk, empresa, false, 'suscripción cancelada');
        break;
      }

      // Stripe reintenta el cobro varios días. No se corta el acceso aquí: cuando
      // de verdad se agote, manda customer.subscription.updated con el estado final.
      case 'invoice.payment_failed': {
        console.warn('[webhook] cobro fallido, cliente:', obj.customer, '· intento', obj.attempt_count);
        break;
      }
    }
  } catch (e) {
    // 500 hace que Stripe reintente, que es lo correcto ante un fallo transitorio.
    console.error('[webhook] error procesando', evento.type, e?.message || e);
    return res.status(500).json({ error: 'Error al procesar' });
  }

  return res.status(200).json({ recibido: true });
};
