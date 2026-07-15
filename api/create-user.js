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
    if (!email || !password || password.length < 6)
      return res.status(400).json({ error: 'Email y contraseña (mín. 6 caracteres) requeridos' });

    const result = await supabaseReq('/auth/v1/admin/users', 'POST',
      { email, password, email_confirm: true }, srk);

    if (result.status !== 200 && result.status !== 201) {
      const msg = result.body?.msg || result.body?.message || result.body?.error_description || 'Error al crear usuario';
      return res.status(400).json({ error: msg });
    }

    // Precrear la fila en `empresas` para que la tarjeta de ajustes (plan, modulos,
    // moneda, umbrales) exista desde el alta, sin esperar al primer login del cliente.
    const defaultConfig = {
      plan: 'basico',
      modulosVisibles: null,
      moneda: null,
      ivaTasa: null,
      umbrales: { margenEbitdaMin: null, razCorrienteMin: null, debtEbitdaMax: null, dsoMax: null },
    };
    const empresaResult = await supabaseReq('/rest/v1/empresas', 'POST', {
      user_id: result.body.id,
      nombre: 'Sin nombre',
      data: { config: defaultConfig },
      updated_at: new Date().toISOString(),
    }, srk);
    if (empresaResult.status !== 200 && empresaResult.status !== 201) {
      console.error('[create-user] No se pudo precrear empresas:', empresaResult.status, empresaResult.body);
    }

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
