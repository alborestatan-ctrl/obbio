const https = require('https');

function supabaseReq(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const host = new URL(process.env.SUPABASE_URL).hostname;
    const data = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${token}`,
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: host, path, method, headers }, (res) => {
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

async function verifyAdmin(callerJwt) {
  const res = await supabaseReq('/auth/v1/user', 'GET', null, callerJwt);
  if (res.status !== 200) return false;
  return res.body?.app_metadata?.role === 'admin'
      || res.body?.user?.app_metadata?.role === 'admin';
}

// Precrear la fila en `empresas` para que la tarjeta de ajustes (plan, modulos,
// moneda, umbrales) exista desde el alta, sin esperar al primer login del cliente.
async function precrearEmpresa(userId, srk) {
  if (!userId) return;
  const defaultConfig = {
    plan: 'basico',
    modulosVisibles: null,
    moneda: null,
    ivaTasa: null,
    umbrales: { margenEbitdaMin: null, razCorrienteMin: null, debtEbitdaMax: null, dsoMax: null },
  };
  const r = await supabaseReq('/rest/v1/empresas', 'POST', {
    user_id: userId,
    nombre: 'Sin nombre',
    data: { config: defaultConfig },
    updated_at: new Date().toISOString(),
  }, srk);
  if (r.status !== 200 && r.status !== 201)
    console.error('[create-user] No se pudo precrear empresas:', r.status, r.body);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const callerJwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!callerJwt) return res.status(401).json({ error: 'No autorizado' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ error: 'Variables de entorno no configuradas' });

  const isAdmin = await verifyAdmin(callerJwt);
  if (!isAdmin) return res.status(403).json({ error: 'Solo el administrador puede gestionar usuarios' });

  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (req.method === 'POST') {
    const { email, password } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email requerido' });
    if (password && password.length < 6)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    // ── Modo invitación (sin contraseña) ──────────────────────────────────────
    // Se genera un link de activación y el cliente pone su propia contraseña en la
    // pantalla "Crea tu contraseña". La contraseña nunca viaja ni la conoce nadie más.
    //
    // Se usa generate_link y NO /invite a propósito: /invite manda el correo con el
    // SMTP de Supabase, que "se niega a entregar mensajes a direcciones que no son
    // del equipo del proyecto" y está limitado a 2 por hora — a un cliente real no le
    // llegaría. generate_link solo DEVUELVE el link, para enviarlo por el medio que sea.
    if (!password) {
      const redirectTo = process.env.APP_URL
        || (req.headers.host ? 'https://' + req.headers.host : null);
      const cuerpo = (tipo) => {
        const b = { type: tipo, email };
        if (redirectTo) b.redirect_to = redirectTo;
        return b;
      };

      let tipo = 'invite';
      let link = await supabaseReq('/auth/v1/admin/generate_link', 'POST', cuerpo(tipo), srk);

      // A un cliente que ya existe no se le puede invitar de nuevo. Un link de
      // recuperación aterriza en la MISMA pantalla (el overlay maneja invite y
      // recovery), así que sirve para reenviarle el acceso a alguien que lo perdió.
      if (link.status === 422 || link.status === 400) {
        tipo = 'recovery';
        link = await supabaseReq('/auth/v1/admin/generate_link', 'POST', cuerpo(tipo), srk);
      }

      if (link.status !== 200 && link.status !== 201) {
        const msg = link.body?.msg || link.body?.message || link.body?.error_description || 'No se pudo generar el acceso';
        return res.status(400).json({ error: msg });
      }

      const actionLink = link.body?.action_link || link.body?.properties?.action_link;
      if (!actionLink)
        return res.status(502).json({ error: 'Supabase no devolvió el link de activación' });

      const userId = link.body?.id || link.body?.user?.id || null;
      if (userId && tipo === 'invite') await precrearEmpresa(userId, srk);

      return res.status(200).json({ id: userId, email, action_link: actionLink, tipo });
    }

    // ── Modo contraseña manual (comportamiento previo) ─────────────────────────
    const result = await supabaseReq('/auth/v1/admin/users', 'POST',
      { email, password, email_confirm: true }, srk);

    if (result.status !== 200 && result.status !== 201) {
      const msg = result.body?.msg || result.body?.message || result.body?.error_description || 'Error al crear usuario';
      return res.status(400).json({ error: msg });
    }

    await precrearEmpresa(result.body.id, srk);

    return res.status(200).json({ id: result.body.id, email: result.body.email });
  }

  if (req.method === 'DELETE') {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId requerido' });

    const result = await supabaseReq(`/auth/v1/admin/users/${userId}`, 'DELETE', null, srk);
    if (result.status !== 200 && result.status !== 204)
      return res.status(400).json({ error: 'Error al eliminar usuario' });

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
};
