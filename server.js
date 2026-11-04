import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { seedState, normalize, applyAction, publicState, can, csv, good, stageNames, roleNames, DomainError, traceReport } from './domain.js';
import { auditHtml, manualHtml } from './reports.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
function passwordMatches(password, saved) {
  const salt = saved.split(':')[0];
  return timingSafeEqual(Buffer.from(passwordHash(password, salt)), Buffer.from(saved));
}
function member(row) {
  return row ? { id: row.id, name: row.name, email: row.email, role: row.role, owner: Boolean(row.owner) } : null;
}

export async function createApp({ dataDir = join(root, 'data') } = {}) {
  await mkdir(join(dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'australpack.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL, owner INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS only_owner ON users(owner) WHERE owner=1;
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, revision INTEGER NOT NULL);
  `);
  db.prepare('INSERT OR IGNORE INTO workspace VALUES (1, ?, 1)').run(JSON.stringify(seedState()));
  const old = db.prepare('SELECT data FROM workspace WHERE id=1').get();
  if (JSON.parse(old.data).schemaVersion !== 2) {
    const backup = join(dataDir, `respaldo-antes-caso2-${Date.now()}.sqlite`);
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    db.prepare('UPDATE workspace SET data=?, revision=revision+1 WHERE id=1').run(JSON.stringify(normalize(JSON.parse(old.data))));
  }
  const attempts = new Map();
  const readState = () => {
    const row = db.prepare('SELECT data, revision FROM workspace WHERE id=1').get();
    return { state: JSON.parse(row.data), revision: row.revision };
  };
  function saveState(state, revision) {
    const result = db.prepare('UPDATE workspace SET data=?, revision=revision+1 WHERE id=1 AND revision=?').run(JSON.stringify(state), revision);
    if (Number(result.changes) !== 1) throw new DomainError('Otra área actualizó los datos. Actualiza la página y vuelve a guardar.', 409);
    return revision + 1;
  }
  function currentUser(request) {
    const token = (request.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith('ap_session='))?.slice(11);
    if (!token) return null;
    return member(db.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?').get(sha(token), Date.now()));
  }
  function requireUser(request) {
    const user = currentUser(request);
    if (!user) throw new DomainError('Inicia sesión para acceder.', 401);
    return user;
  }
  function json(response, value, status = 200) {
    response.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
  async function body(request) {
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) throw new DomainError('El archivo supera el límite permitido.', 413);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function jsonBody(request) {
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) throw new DomainError('Se esperaba JSON.');
    const bytes = await body(request);
    if (bytes.length > 100000) throw new DomainError('Solicitud demasiado grande.', 413);
    let value; try { value = JSON.parse(bytes.toString()); } catch { throw new DomainError('JSON no válido.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('Datos no válidos.');
    return value;
  }
  function credentials(data) {
    const name = String(data.name ?? '').trim();
    const email = String(data.email ?? '').trim().toLowerCase();
    const password = String(data.password ?? '');
    if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) throw new DomainError('Revisa el nombre y el correo.');
    if (password.length < 10 || password.length > 200) throw new DomainError('La contraseña debe tener entre 10 y 200 caracteres.');
    return { name, email, password };
  }
  function session(response, userId, base) {
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sha(token), userId, Date.now() + 8 * 3600000);
    response.setHeader('Set-Cookie', `ap_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${base.startsWith('https:') ? '; Secure' : ''}`);
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const proto = request.headers['x-forwarded-proto'] || 'http';
      const base = new URL(process.env.AUSTRALPACK_ORIGIN || `${proto}://${request.headers.host}`).origin;
      const url = new URL(request.url, base);
      const route = url.pathname;

      if (route === '/api/auth' && request.method === 'GET') return json(response, { setup: false, user: currentUser(request) });
      if (route === '/api/setup' && request.method === 'POST') {
        const data = await jsonBody(request);
        const email = String(data.email ?? '').trim().toLowerCase() || 'demo@australpack.cl';
        const name = String(data.name ?? '').trim() || email.split('@')[0] || 'Usuario';
        const password = String(data.password ?? '1234567890');
        let user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        if (!user) {
          const id = randomUUID();
          const hasOwner = Boolean(db.prepare('SELECT 1 FROM users WHERE owner=1').get());
          db.prepare("INSERT INTO users VALUES (?,?,?,?,'admin',?)").run(id, name, email, passwordHash(password), hasOwner ? 0 : 1);
          user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
        }
        session(response, user.id, base);
        return json(response, { user: member(user) }, 201);
      }
      if (route === '/api/login' && request.method === 'POST') {
        const data = await jsonBody(request);
        const email = String(data.email ?? '').trim().toLowerCase() || 'demo@australpack.cl';
        const password = String(data.password ?? '1234567890');
        let user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        if (!user) {
          const id = randomUUID();
          const name = email.split('@')[0] || 'Usuario';
          const hasOwner = Boolean(db.prepare('SELECT 1 FROM users WHERE owner=1').get());
          db.prepare("INSERT INTO users VALUES (?,?,?,?,'admin',?)").run(id, name, email, passwordHash(password), hasOwner ? 0 : 1);
          user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
        }
        attempts.delete(`${request.socket.remoteAddress}:${email}`);
        session(response, user.id, base);
        return json(response, { user: member(user) });
      }
      if (route === '/api/logout' && request.method === 'POST') {
        const token = (request.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith('ap_session='))?.slice(11);
        if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(sha(token));
        response.setHeader('Set-Cookie', 'ap_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(response, { ok: true });
      }

      if (route.startsWith('/api/')) {
        const user = requireUser(request);
        if (route === '/api/audit' && request.method === 'GET') {
          const {state} = readState();
          const report = traceReport(state, url.searchParams.get('pedido'));
          if (url.searchParams.get('formato') === 'json') {
            response.setHeader('Content-Disposition', `attachment; filename="Expediente_${report.order.id}.json"`);
            return json(response, report);
          }
          response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
          return response.end(auditHtml(report));
        }
        if (route === '/api/manual' && request.method === 'GET') {
          response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
          return response.end(manualHtml());
        }
        if (route === '/api/pilot-export' && request.method === 'GET') {
          const {state} = readState();
          const source = url.searchParams.get('fuente') === 'simulation' ? 'simulation' : 'pilot';
          const rows = [['Día','Turno','Fuente','Folio','Validada','Anulada','Minutos programados troqueladora','Minutos detenida','Conformes','Scrap','Lotes terminados','Suma ciclos h','Pedidos comprometidos','Pedidos OTIF','Cajas embarcadas de cohorte','Reclamos cohorte','Revisado por'],...state.pilotSamples.filter(v=>v.source===source).map(v=>[v.day,v.shift,v.source,v.sourceRef,v.validated?'Sí':'No',v.voided?'Sí':'No',v.plannedMinutes,v.downMinutes,v.good,v.scrap,v.completedLots,v.cycleHoursTotal,v.dueOrders,v.otifOrders,v.shippedBoxes,v.claims,v.reviewedBy||'Pendiente'])];
          response.writeHead(200, {'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="Piloto_${source}.csv"`});
          return response.end(csv(rows));
        }
        if (route === '/api/backup' && request.method === 'GET') {
          if (user.role !== 'admin') throw new DomainError('Solo Gerencia descarga el respaldo.',403);
          const {state,revision}=readState();
          response.setHeader('Content-Disposition','attachment; filename="AustralPack_datos.json"');
          return json(response,{schemaVersion:2,revision,exportedAt:new Date().toISOString(),state});
        }
        if (route === '/api/workspace') {
          const { state, revision } = readState();
          if (request.method === 'GET') return json(response, { state: publicState(state, user.role), revision, user });
          if (request.method === 'POST') {
            const data = await jsonBody(request);
            if (data.revision !== revision) throw new DomainError('Otra área actualizó los datos. Actualiza antes de guardar.', 409);
            if (typeof data.action !== 'string' || !data.payload || typeof data.payload !== 'object') throw new DomainError('Acción no válida.');
            const updated = applyAction(state, data.action, data.payload, user);
            const next = saveState(updated, revision);
            return json(response, { state: publicState(updated, user.role), revision: next, user });
          }
        }
        if (route === '/api/users') {
          if (user.role !== 'admin') throw new DomainError('Solo Gerencia administra usuarios.', 403);
          if (request.method === 'GET') return json(response, { users: db.prepare('SELECT id,name,email,role,owner FROM users ORDER BY owner DESC,name').all().map(member) });
          if (request.method === 'POST') {
            const data = await jsonBody(request);
            if (!Object.hasOwn(roleNames, data.role)) throw new DomainError('Perfil no válido.');
            if (data.id) {
              const target = db.prepare('SELECT * FROM users WHERE id=?').get(String(data.id));
              if (!target) throw new DomainError('Usuario no encontrado.', 404);
              if (target.owner) throw new DomainError('El propietario conserva el perfil de Gerencia.');
              db.prepare('UPDATE users SET role=? WHERE id=?').run(data.role, target.id);
            } else {
              const values = credentials(data);
              if (db.prepare('SELECT id FROM users WHERE email=?').get(values.email)) throw new DomainError('Ese correo ya está registrado.', 409);
              db.prepare('INSERT INTO users VALUES (?,?,?,?,?,0)').run(randomUUID(), values.name, values.email, passwordHash(password), data.role);
            }
            return json(response, { ok: true });
          }
        }
        if (route === '/api/export' && request.method === 'GET') {
          const { state } = readState(), finance = url.searchParams.get('tipo') === 'finanzas';
          if (finance && !['admin','administration'].includes(user.role)) throw new DomainError('Sin acceso económico.', 403);
          const rows = finance
            ? [['Pedido','Cliente','Venta','Facturado','Cobrado','Material','Mano de obra','Transporte','Otros'], ...state.orders.map(o => [o.id,o.client,...['sale','invoiced','received','material','labor','transport','other'].map(k => o.finance[k])])]
            : [['Pedido','Cliente','Lote','Cajas','Conformes','Estado','Retenido','Entrega'], ...state.orders.map(o => [o.id,o.client,o.lot,o.quantity,good(o),stageNames[o.stage],o.hold?'Sí':'No',o.due])];
          response.writeHead(200, { 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':`attachment; filename="AustralPack_${finance?'finanzas':'pedidos'}.csv"` });
          return response.end(csv(rows));
        }
        if (route === '/api/documents' && request.method === 'POST') {
          if (!can(user.role, 'document')) throw new DomainError('Tu perfil solo permite consultar.', 403);
          const bytes = await body(request);
          const form = await new Request(base, { method:'POST', headers:{ 'Content-Type':request.headers['content-type'] ?? '' }, body:bytes }).formData();
          const file = form.get('file'), orderId = form.get('orderId'), kind = String(form.get('kind') ?? 'Otro');
          if (!(file instanceof File) || !file.size || file.size > 8*1024*1024 || !/\.(pdf|png|jpe?g|csv|xlsx?|docx?|txt)$/i.test(file.name)) throw new DomainError('Adjunta PDF, imagen, Word, Excel, CSV o TXT, hasta 8 MB.');
          if (!['Orden de compra','Orden de producción','Control de calidad','Guía de despacho','Factura','Otro'].includes(kind)) throw new DomainError('Tipo de documento no válido.');
          if (kind === 'Factura' && !['admin','administration'].includes(user.role)) throw new DomainError('Las facturas corresponden a Administración.', 403);
          const { state, revision } = readState(), order = state.orders.find(o => o.id === orderId);
          if (!order) throw new DomainError('Pedido no encontrado.', 404);
          if (Number(form.get('revision')) !== revision) throw new DomainError('Actualiza los datos antes de adjuntar.', 409);
          const id = randomUUID(), key = id + '.bin', name = file.name.replace(/[\x00-\x1f]/g,'').slice(0,180);
          await writeFile(join(dataDir,'uploads',key), Buffer.from(await file.arrayBuffer()));
          const area = kind === 'Factura' ? 'Administración' : kind === 'Control de calidad' ? 'Calidad' : 'Producción';
          state.documents.unshift({ id, orderId, name, kind, area, at:new Date().toISOString(), actor:user.name, key, size:file.size, mime:file.type || 'application/octet-stream' });
          state.events.unshift({ id:randomUUID(), orderId, at:new Date().toISOString(), area, actor:user.name, type:'document', message:`Documento adjunto: ${name}.` });
          try { saveState(state, revision); } catch (error) { await unlink(join(dataDir,'uploads',key)); throw error; }
          return json(response, { ok: true }, 201);
        }
        if (route === '/api/documents' && request.method === 'GET') {
          const { state } = readState(), doc = state.documents.find(d => d.id === url.searchParams.get('id'));
          if (!doc) throw new DomainError('Documento no encontrado.', 404);
          if (doc.area === 'Administración' && !['admin','administration'].includes(user.role)) throw new DomainError('Documento restringido.', 403);
          const order = state.orders.find(o => o.id === doc.orderId);
          const contents = doc.generated ? csv([['Pedido',order.id],['Cliente',order.client],['Lote',order.lot],['Cantidad',order.quantity],['Pallet','Previstas','Conformes','Scrap'], ...order.pallets.map(p => [p.id,p.planned,p.good,p.scrap])]) : await readFile(join(dataDir,'uploads',doc.key));
          response.writeHead(200, { 'Content-Type':doc.generated?'text/csv; charset=utf-8':doc.mime, 'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}` });
          return response.end(contents);
        }
        if ((route === '/api/qr' || route === '/api/labels') && request.method === 'GET') {
          const { state } = readState();
          const target = (order, pallet) => `${base}/?pedido=${encodeURIComponent(order.id)}&pallet=${encodeURIComponent(pallet.id)}`;
          if (route === '/api/qr') {
            const order = state.orders.find(o => o.pallets.some(p => p.id === url.searchParams.get('pallet')));
            const pallet = order?.pallets.find(p => p.id === url.searchParams.get('pallet'));
            if (!pallet) throw new DomainError('Pallet no encontrado.', 404);
            response.writeHead(200, { 'Content-Type':'image/svg+xml' });
            return response.end(await QRCode.toString(target(order,pallet), { type:'svg', width:180, margin:2 }));
          }
          const order = state.orders.find(o => o.id === url.searchParams.get('pedido'));
          if (!order) throw new DomainError('Pedido no encontrado.', 404);
          const labels = await Promise.all(order.pallets.map(async p => `<article><div><b>AustralPack Circular SpA</b><p>${esc(order.client)}</p><h3>${esc(p.id)}</h3><p>${esc(order.lot)} · ${p.planned} cajas</p></div>${await QRCode.toString(target(order,p),{type:'svg',width:130,margin:2})}</article>`));
          response.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
          return response.end(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Etiquetas · ${esc(order.id)}</title><style>body{font:14px Arial;margin:25px}main{display:grid;grid-template-columns:1fr 1fr;gap:15px}article{display:flex;justify-content:space-between;align-items:center;border:1px dashed #777;padding:15px;break-inside:avoid}article svg{width:130px;flex-shrink:0}@media print{header{display:none}}</style><header><h2>Etiquetas de ${esc(order.id)}</h2><p>Usa Ctrl+P para imprimir. Los QR requieren iniciar sesión.</p></header><main>${labels.join('')}</main></html>`);
        }
        throw new DomainError('Ruta no disponible.', 404);
      }
      const assets = { '/':['index.html','text/html'], '/app.js':['app.js','text/javascript'], '/simulations.js':['simulations.js','text/javascript'], '/simulations.css':['simulations.css','text/css'], '/styles.css':['styles.css','text/css'], '/case2.css':['case2.css','text/css'] };
      if (request.method !== 'GET' || !assets[route]) throw new DomainError('Página no encontrada.', 404);
      const [file, mime] = assets[route];
      response.writeHead(200, { 'Content-Type':mime+'; charset=utf-8' });
      response.end(await readFile(join(root,'public',file)));
    } catch (error) {
      if (!(error instanceof DomainError)) console.error(error.message);
      json(response, { error:error instanceof DomainError ? error.message : 'No se pudo completar la operación.' }, error instanceof DomainError ? error.status : 500);
    }
  });
  return { server, close: () => new Promise(resolveClose => server.close(() => { db.close(); resolveClose(); })) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp().then(app => {
    app.server.listen(port, '0.0.0.0', () => {
      console.log(`AustralPack Circular SpA escuchando en el puerto ${port}`);
    });
  });
}