// Service de StudioGLSC (studio.glsc.fr) : demandes de devis et suivi de projet client. Aucune dépendance.
//
// Deux écoutes :
//   publique (127.0.0.1:3302, derrière nginx sous https://studio.glsc.fr/api/) : formulaire de contact, page de suivi d'un client
//   admin    (127.0.0.1:3303, jamais exposée par nginx) : appelée par l'admin PHP avec un jeton partagé (fichier monté en lecture seule)
//
// Données personnelles : le strict nécessaire pour répondre (nom, e-mail, téléphone facultatif, message). Aucune adresse IP n'est
// enregistrée (la limitation de débit se fait en mémoire). Les demandes et les projets terminés sont supprimés après RETENTION_DAYS.
// Fichiers : seuls les types listés dans ALLOWED sont acceptés, reconnus par leur contenu et non par leur nom ; ils ne sont jamais servis
// par la porte publique (téléchargement par l'admin uniquement, en pièce jointe).
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';

const DAY = 86_400_000;
const MAX_JSON = 16_384;
export const MAX_UPLOAD = 8 * 1024 * 1024;
const MAX_FILES_PER_PROJECT = 40;
const MAX_BYTES_PER_PROJECT = 60 * 1024 * 1024;
const MAX_MESSAGES_PER_PROJECT = 400;
export const ACTIVITIES = ['Artisan / BTP', 'Commerce', 'Restauration', 'Santé et bien-être', 'Beauté', 'Association ou club', 'Autre activité'];
export const SERVICES = ['One-Page Express', 'Refonte ou site multi-pages', 'Hébergement et suivi', 'Autre demande'];
export const TIMINGS = ['Dès que possible', 'Dans le mois', 'Je ne suis pas pressé'];
export const REQUEST_STATUSES = ['new', 'contacted', 'quote', 'won', 'lost'];
export const PROJECT_STATUSES = ['active', 'done', 'archived'];
export const DEFAULT_STEPS = ['Cadrage', 'Contenus reçus', 'Création', 'Vos retours', 'Mise en ligne'];

const sha = (s) => createHash('sha256').update(s).digest('hex');
const tokenHash = (t) => sha('studio-project:' + t);
const newId = () => randomBytes(6).toString('hex');
const newToken = () => randomBytes(16).toString('hex'); // 128 bits

/** Texte libre : NFC, sans caractères de contrôle (sauf retours à la ligne), espaces en bout retirés, longueur bornée. */
export function clean(raw, max, { multiline = false } = {}) {
  if (typeof raw !== 'string') return '';
  let s = raw.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\p{Cc}\p{Cf}]/gu, (c) => (multiline && c === '\n' ? c : ''));
  if (multiline) s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim().slice(0, max);
}
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const PHONE_RE = /^[+\d][\d .()/-]{5,24}$/;

/** Valide le formulaire de contact. Renvoie { ok: {...} } ou { error }. */
export function checkContact(b) {
  if (!b || typeof b !== 'object') return { error: 'Requête invalide.' };
  const name = clean(b.name, 80);
  const email = clean(b.email, 120).toLowerCase();
  const phone = clean(b.phone, 25);
  const message = clean(b.message, 2000, { multiline: true });
  if (name.length < 2) return { error: 'Indiquez votre nom.' };
  if (!EMAIL_RE.test(email) || email.length > 120) return { error: 'Cette adresse e-mail ne semble pas valide.' };
  if (phone && !PHONE_RE.test(phone)) return { error: 'Ce numéro de téléphone ne semble pas valide.' };
  if (!ACTIVITIES.includes(b.activity)) return { error: 'Choisissez votre activité.' };
  if (!SERVICES.includes(b.service)) return { error: 'Choisissez votre besoin.' };
  if (!TIMINGS.includes(b.timing)) return { error: 'Choisissez un délai.' };
  return { ok: { name, email, phone, message, activity: b.activity, service: b.service, timing: b.timing } };
}

/** Type d'un fichier d'après son contenu (et, pour les formats zip et texte, d'après l'extension demandée). */
export function sniff(buf, filename = '') {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(filename)?.[1] ?? '').toLowerCase();
  const at = (i, ...bytes) => bytes.every((b, k) => buf[i + k] === b);
  if (!buf.length) return null;
  if (at(0, 0xff, 0xd8, 0xff)) return { ext: 'jpg', mime: 'image/jpeg' };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { ext: 'webp', mime: 'image/webp' };
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return { ext: 'pdf', mime: 'application/pdf' };
  if (at(0, 0x50, 0x4b, 0x03, 0x04) && ['docx', 'xlsx', 'odt', 'ods'].includes(ext)) return { ext, mime: 'application/octet-stream' };
  if (['txt', 'md', 'csv'].includes(ext)) {
    if (buf.subarray(0, 8192).includes(0)) return null;
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
    return { ext, mime: 'text/plain' };
  }
  return null;
}

// ---- stockage : un fichier JSON écrit de façon atomique
function loadStore(dir) {
  const file = join(dir, 'studio.json');
  mkdirSync(dir, { recursive: true });
  let data = { v: 1, requests: [], projects: [] };
  if (existsSync(file)) data = { ...data, ...JSON.parse(readFileSync(file, 'utf8')) };
  let timer = null;
  const flush = () => { timer = null; const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(data), { mode: 0o640 }); renameSync(tmp, file); };
  return { data, save() { if (!timer) { timer = setTimeout(flush, 150); timer.unref?.(); } }, saveNow() { if (timer) clearTimeout(timer); flush(); } };
}

function limiter() {
  const hits = new Map();
  return (key, max, windowMs) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(now); hits.set(key, list);
    if (hits.size > 20_000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3_600_000) hits.delete(k);
    return true;
  };
}

export function createStudioService(options = {}) {
  const {
    dataDir = '/data',
    adminTokenFile = '/run/secrets/studio-token',
    allowedOrigins = ['https://studio.glsc.fr'],
    retentionDays = 365,
    siteUrl = 'https://studio.glsc.fr',
  } = options;
  const store = loadStore(dataDir);
  const { data } = store;
  const allow = limiter();
  const origins = new Set(allowedOrigins);
  const uploads = join(dataDir, 'uploads');
  const eventsFile = join(dataDir, 'events.jsonl');
  const event = (type, extra = {}) => { try { appendFileSync(eventsFile, JSON.stringify({ t: Math.floor(Date.now() / 1000), type, ...extra }) + '\n', { mode: 0o640 }); } catch { /* l'historique des alertes n'empêche jamais une demande */ } };

  // ---- jeton de l'admin : relu quand le fichier change
  let tokenCache = { mtime: 0, digest: null };
  const adminDigest = () => {
    try {
      const m = statSync(adminTokenFile).mtimeMs;
      if (m !== tokenCache.mtime) { const t = readFileSync(adminTokenFile, 'utf8').trim(); tokenCache = { mtime: m, digest: t.length >= 32 ? createHash('sha256').update(t).digest() : null }; }
    } catch { tokenCache = { mtime: 0, digest: null }; }
    return tokenCache.digest;
  };
  const adminOk = (header) => {
    const want = adminDigest();
    if (!want || typeof header !== 'string' || header.length > 200) return false;
    return timingSafeEqual(want, createHash('sha256').update(header).digest());
  };

  const findProject = (token) => {
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null;
    const h = tokenHash(token);
    return data.projects.find((p) => p.tokenHash === h) ?? null;
  };
  const publicProject = (p) => ({
    title: p.title, client: p.client, status: p.status,
    steps: p.steps.map((label, i) => ({ label, state: p.status === 'done' || i < p.current ? 'done' : i === p.current ? 'current' : 'todo' })),
    messages: p.messages.slice(-100).map((m) => ({ from: m.from, at: m.at, text: m.text })),
    files: p.files.map((f) => ({ name: f.name, size: f.size, at: f.at })),
  });
  const adminProject = (p) => ({
    id: p.id, title: p.title, client: p.client, status: p.status, current: p.current, steps: p.steps, createdAt: p.createdAt, closedAt: p.closedAt ?? null,
    messages: p.messages, unread: p.unread ?? 0, files: p.files.map((f) => ({ id: f.id, name: f.name, size: f.size, at: f.at, type: f.type })),
  });
  const bytesOf = (p) => p.files.reduce((a, f) => a + f.size, 0);

  // ---- conservation limitée
  function purge(now = Date.now()) {
    const limit = now - retentionDays * DAY;
    const before = data.requests.length + data.projects.length;
    data.requests = data.requests.filter((r) => r.at * 1000 > limit);
    const gone = data.projects.filter((p) => p.closedAt && p.closedAt * 1000 <= limit);
    for (const p of gone) rmSync(join(uploads, p.id), { recursive: true, force: true });
    data.projects = data.projects.filter((p) => !gone.includes(p));
    if (data.requests.length + data.projects.length !== before) store.save();
    return before - (data.requests.length + data.projects.length);
  }
  purge();
  const purgeTimer = setInterval(() => purge(), 6 * 3_600_000);
  purgeTimer.unref?.();

  // ---------------------------------------------------------------- routes publiques
  const publicRoutes = {
    'GET /health': () => ({ body: { ok: true } }),
    'POST /contact': ({ ip, body }) => {
      if (!allow(`c:${ip}`, 5, 3_600_000) || !allow(`cd:${ip}`, 15, DAY)) return { status: 429, body: { error: 'Trop de demandes depuis cette connexion. Écrivez-moi directement à pro@glsc.fr.' } };
      if (typeof body.website === 'string' && body.website) return { body: { ok: true } }; // champ piège : on fait semblant d'avoir reçu
      const v = checkContact(body);
      if (v.error) return { status: 422, body: { error: v.error } };
      const dup = data.requests.find((r) => r.email === v.ok.email && r.message === v.ok.message && r.service === v.ok.service && Date.now() / 1000 - r.at < 600);
      if (dup) return { body: { ok: true } };
      const rec = { id: newId(), at: Math.floor(Date.now() / 1000), status: 'new', note: '', ...v.ok };
      data.requests.push(rec);
      if (data.requests.length > 2000) data.requests.shift();
      store.save();
      event('request', { id: rec.id, service: rec.service, activity: rec.activity, timing: rec.timing });
      return { status: 201, body: { ok: true } };
    },
    'POST /project': ({ ip, body }) => {
      if (!allow(`p:${ip}`, 120, 60_000)) return { status: 429, body: { error: 'Doucement.' } };
      const p = findProject(body.token);
      if (!p) return { status: 404, body: { error: 'Lien de suivi introuvable ou expiré.' } };
      return { body: { project: publicProject(p) } };
    },
    'POST /project/message': ({ ip, body }) => {
      if (!allow(`pm:${ip}`, 20, 3_600_000)) return { status: 429, body: { error: 'Trop de messages. Réessayez plus tard.' } };
      const p = findProject(body.token);
      if (!p) return { status: 404, body: { error: 'Lien de suivi introuvable ou expiré.' } };
      const text = clean(body.text, 2000, { multiline: true });
      if (text.length < 1) return { status: 422, body: { error: 'Écrivez un message.' } };
      if (p.messages.length >= MAX_MESSAGES_PER_PROJECT) return { status: 409, body: { error: 'Trop de messages sur ce projet : écrivez-moi par e-mail.' } };
      p.messages.push({ id: newId(), at: Math.floor(Date.now() / 1000), from: 'client', text });
      p.unread = (p.unread ?? 0) + 1;
      store.save();
      event('client-message', { project: p.id });
      return { status: 201, body: { project: publicProject(p) } };
    },
  };

  async function readBytes(req, max) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('too big'), { status: 413 }); chunks.push(c); }
    return Buffer.concat(chunks);
  }
  async function readJson(req, max = MAX_JSON) {
    const buf = await readBytes(req, max);
    if (!buf.length) return {};
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new Error('type'), { status: 415 });
    try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { throw Object.assign(new Error('json'), { status: 400 }); }
  }

  function respond(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(status === 204 ? '' : JSON.stringify(body ?? {}));
  }

  const publicServer = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const origin = req.headers.origin;
      if (req.method === 'POST' && typeof origin === 'string' && !origins.has(origin)) return respond(res, 403, { error: 'Origine refusée.' });
      const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '?').slice(0, 64);
      if (req.method === 'POST' && path === '/project/upload') {
        if (!allow(`pu:${ip}`, 20, 3_600_000)) return respond(res, 429, { error: 'Trop d’envois. Réessayez plus tard.' });
        const p = findProject(req.headers['x-project-token']);
        if (!p) return respond(res, 404, { error: 'Lien de suivi introuvable ou expiré.' });
        const declared = Number(req.headers['content-length'] ?? 0);
        if (declared > MAX_UPLOAD) return respond(res, 413, { error: 'Fichier trop lourd (8 Mo au maximum).' });
        let name = 'fichier';
        try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'fichier')); } catch { /* nom illisible : valeur par défaut */ }
        name = clean(name.replace(/[\\/]/g, '_'), 120) || 'fichier';
        const buf = await readBytes(req, MAX_UPLOAD);
        const kind = sniff(buf, name);
        if (!kind) return respond(res, 415, { error: 'Format non accepté. Envoyez une image (JPG, PNG, WebP), un PDF, un document Word, Excel ou LibreOffice, ou un fichier texte.' });
        if (p.files.length >= MAX_FILES_PER_PROJECT || bytesOf(p) + buf.length > MAX_BYTES_PER_PROJECT) return respond(res, 409, { error: 'Espace de dépôt plein pour ce projet : écrivez-moi par e-mail.' });
        const fid = randomBytes(8).toString('hex');
        mkdirSync(join(uploads, p.id), { recursive: true, mode: 0o750 });
        writeFileSync(join(uploads, p.id, `${fid}.${kind.ext}`), buf, { mode: 0o640 });
        p.files.push({ id: fid, at: Math.floor(Date.now() / 1000), name, size: buf.length, type: kind.mime, ext: kind.ext });
        p.unread = (p.unread ?? 0) + 1;
        store.save();
        event('client-file', { project: p.id });
        return respond(res, 201, { project: publicProject(p) });
      }
      const handler = publicRoutes[`${req.method} ${path}`];
      if (!handler) return respond(res, 404, { error: 'Introuvable.' });
      const body = req.method === 'POST' ? await readJson(req) : {};
      const out = handler({ ip, body });
      respond(res, out.status ?? 200, out.body);
    } catch (e) {
      respond(res, e.status ?? 500, { error: e.status ? 'Requête invalide.' : 'Erreur du serveur.' });
    }
  });

  // ---------------------------------------------------------------- routes admin
  const byId = (list, id) => list.find((x) => x.id === id);
  const adminRoutes = {
    'GET /admin/overview': () => ({
      body: {
        requests: [...data.requests].sort((a, b) => b.at - a.at),
        projects: [...data.projects].sort((a, b) => b.createdAt - a.createdAt).map(adminProject),
        retentionDays,
      },
    }),
    'POST /admin/request': ({ body }) => {
      const r = byId(data.requests, body.id);
      if (!r) return { status: 404, body: { error: 'Demande introuvable.' } };
      if (body.status !== undefined) { if (!REQUEST_STATUSES.includes(body.status)) return { status: 422, body: { error: 'Statut inconnu.' } }; r.status = body.status; }
      if (body.note !== undefined) r.note = clean(body.note, 2000, { multiline: true });
      store.save();
      return { body: { request: r } };
    },
    'POST /admin/request/delete': ({ body }) => {
      const i = data.requests.findIndex((r) => r.id === body.id);
      if (i < 0) return { status: 404, body: { error: 'Demande introuvable.' } };
      data.requests.splice(i, 1); store.save();
      return { body: { ok: true } };
    },
    'POST /admin/project/create': ({ body }) => {
      const title = clean(body.title, 80), client = clean(body.client, 80);
      if (title.length < 2 || client.length < 2) return { status: 422, body: { error: 'Titre et client : 2 caractères au moins.' } };
      const steps = Array.isArray(body.steps) && body.steps.length ? body.steps.slice(0, 10).map((s) => clean(s, 40)).filter(Boolean) : DEFAULT_STEPS;
      const token = newToken();
      const p = { id: newId(), tokenHash: tokenHash(token), title, client, status: 'active', current: 0, steps, createdAt: Math.floor(Date.now() / 1000), messages: [], files: [], unread: 0 };
      data.projects.push(p); store.save();
      return { status: 201, body: { project: adminProject(p), link: `${siteUrl}/suivi/#${token}` } };
    },
    'POST /admin/project/update': ({ body }) => {
      const p = byId(data.projects, body.id);
      if (!p) return { status: 404, body: { error: 'Projet introuvable.' } };
      if (body.title !== undefined) p.title = clean(body.title, 80) || p.title;
      if (body.client !== undefined) p.client = clean(body.client, 80) || p.client;
      if (Array.isArray(body.steps) && body.steps.length) { p.steps = body.steps.slice(0, 10).map((s) => clean(s, 40)).filter(Boolean); p.current = Math.min(p.current, p.steps.length); }
      if (body.current !== undefined) { const n = Number(body.current); if (!Number.isInteger(n) || n < 0 || n > p.steps.length) return { status: 422, body: { error: 'Étape inconnue.' } }; p.current = n; }
      if (body.status !== undefined) {
        if (!PROJECT_STATUSES.includes(body.status)) return { status: 422, body: { error: 'Statut inconnu.' } };
        if (body.status !== 'active' && p.status === 'active') p.closedAt = Math.floor(Date.now() / 1000);
        if (body.status === 'active') delete p.closedAt;
        p.status = body.status;
      }
      if (body.read === true) p.unread = 0;
      store.save();
      return { body: { project: adminProject(p) } };
    },
    'POST /admin/project/message': ({ body }) => {
      const p = byId(data.projects, body.id);
      if (!p) return { status: 404, body: { error: 'Projet introuvable.' } };
      const text = clean(body.text, 2000, { multiline: true });
      if (!text) return { status: 422, body: { error: 'Message vide.' } };
      p.messages.push({ id: newId(), at: Math.floor(Date.now() / 1000), from: 'studio', text });
      p.unread = 0; store.save();
      return { status: 201, body: { project: adminProject(p) } };
    },
    'POST /admin/project/link': ({ body }) => {
      const p = byId(data.projects, body.id);
      if (!p) return { status: 404, body: { error: 'Projet introuvable.' } };
      const token = newToken(); p.tokenHash = tokenHash(token); store.save(); // l'ancien lien ne fonctionne plus
      return { body: { link: `${siteUrl}/suivi/#${token}` } };
    },
    'POST /admin/project/delete': ({ body }) => {
      const i = data.projects.findIndex((p) => p.id === body.id);
      if (i < 0) return { status: 404, body: { error: 'Projet introuvable.' } };
      rmSync(join(uploads, data.projects[i].id), { recursive: true, force: true });
      data.projects.splice(i, 1); store.save();
      return { body: { ok: true } };
    },
    'POST /admin/project/file/delete': ({ body }) => {
      const p = byId(data.projects, body.id); const f = p && byId(p.files, body.file);
      if (!f) return { status: 404, body: { error: 'Fichier introuvable.' } };
      rmSync(join(uploads, p.id, `${f.id}.${f.ext}`), { force: true });
      p.files.splice(p.files.indexOf(f), 1); store.save();
      return { body: { project: adminProject(p) } };
    },
  };

  const adminServer = createServer(async (req, res) => {
    try {
      if (!adminOk(req.headers['x-admin-token'])) return respond(res, 401, { error: 'Non autorisé.' });
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const file = req.method === 'GET' ? /^\/admin\/file\/([0-9a-f]{12})\/([0-9a-f]{16})$/.exec(path) : null;
      if (file) {
        const p = byId(data.projects, file[1]); const f = p && byId(p.files, file[2]);
        if (!f) return respond(res, 404, { error: 'Fichier introuvable.' });
        const disk = join(uploads, p.id, `${f.id}.${f.ext}`);
        if (!existsSync(disk)) return respond(res, 404, { error: 'Fichier introuvable.' });
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream', 'Content-Length': String(statSync(disk).size), 'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'no-store',
        });
        return createReadStream(disk).pipe(res);
      }
      const handler = adminRoutes[`${req.method} ${path}`];
      if (!handler) return respond(res, 404, { error: 'Introuvable.' });
      const body = req.method === 'POST' ? await readJson(req) : {};
      const out = handler({ body });
      respond(res, out.status ?? 200, out.body);
    } catch (e) {
      respond(res, e.status ?? 500, { error: e.status ? 'Requête invalide.' : 'Erreur du serveur.' });
    }
  });

  return {
    publicServer, adminServer, store, purge,
    listen(publicPort, adminPort, publicHost = '127.0.0.1', adminHost = '0.0.0.0') {
      return Promise.all([new Promise((r) => publicServer.listen(publicPort, publicHost, r)), new Promise((r) => adminServer.listen(adminPort, adminHost, r))]);
    },
    close() { clearInterval(purgeTimer); store.saveNow(); publicServer.close(); adminServer.close(); },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const svc = createStudioService({
    dataDir: process.env.DATA_DIR ?? '/data',
    adminTokenFile: process.env.ADMIN_TOKEN_FILE ?? '/run/secrets/studio-token',
    retentionDays: Number(process.env.RETENTION_DAYS ?? 365),
    ...(process.env.ALLOWED_ORIGINS ? { allowedOrigins: process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  });
  await svc.listen(Number(process.env.PORT_PUBLIC ?? 3302), Number(process.env.PORT_ADMIN ?? 3303), process.env.HOST_PUBLIC ?? '0.0.0.0');
  console.log('[studio] prêt');
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { svc.close(); process.exit(0); });
}
