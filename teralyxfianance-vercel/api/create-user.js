const https = require('https');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
};

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
  return res.body?.user_metadata?.role === 'admin';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const callerJwt = (event.headers.authorization || '').replace('Bearer ', '');
  if (!callerJwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No autorizado' }) };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Variables de entorno no configuradas' }) };
  }

  const isAdmin = await verifyAdmin(callerJwt);
  if (!isAdmin) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Solo el administrador puede gestionar usuarios' }) };

  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // ── POST: crear usuario ───────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON inválido' }) }; }

    const { email, password } = body;
    if (!email || !password || password.length < 6) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Email y contraseña (mín. 6 caracteres) requeridos' }) };
    }

    const res = await supabaseReq('/auth/v1/admin/users', 'POST',
      { email, password, email_confirm: true }, srk);

    if (res.status !== 200 && res.status !== 201) {
      const msg = res.body?.msg || res.body?.message || res.body?.error_description || 'Error al crear usuario';
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: msg }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ id: res.body.id, email: res.body.email }) };
  }

  // ── DELETE: eliminar usuario ──────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON inválido' }) }; }

    const { userId } = body;
    if (!userId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'userId requerido' }) };

    const res = await supabaseReq(`/auth/v1/admin/users/${userId}`, 'DELETE', null, srk);
    if (res.status !== 200 && res.status !== 204) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Error al eliminar usuario' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Método no permitido' }) };
};
