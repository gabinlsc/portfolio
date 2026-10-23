import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_UPLOAD, checkContact, clean, createStudioService, sniff } from './server.mjs';

const ORIGIN = 'https://studio.glsc.fr';
const TOKEN = 'a'.repeat(40);
let svc, dir, api, admin, tokenFile;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'studio-'));
  tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, TOKEN + '\n');
  svc = createStudioService({ dataDir: join(dir, 'data'), adminTokenFile: tokenFile });
  await svc.listen(0, 0, '127.0.0.1', '127.0.0.1');
  api = `http://127.0.0.1:${svc.publicServer.address().port}`;
  admin = `http://127.0.0.1:${svc.adminServer.address().port}`;
});
after(() => { svc.close(); rmSync(dir, { recursive: true, force: true }); });

const good = { name: 'Léa Martin', email: 'Lea@Example.fr', phone: '06 12 34 56 78', activity: 'Commerce', service: 'One-Page Express', timing: 'Dans le mois', message: 'Bonjour,\n\nJe voudrais un site.' };
const post = (path, body, { ip = '1.1.1.1', origin = ORIGIN, base = api, headers = {} } = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip, ...(origin ? { origin } : {}), ...headers }, body: JSON.stringify(body) });
const adm = (path, body, token = TOKEN) => fetch(admin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token }, body: body === undefined ? undefined : JSON.stringify(body) });

test('texte libre : contrôles retirés, retours à la ligne gardés si demandé, longueur bornée', () => {
  assert.equal(clean('  a\u0000b‮c  ', 10), 'abc');
  assert.equal(clean('a\n\n\n\nb', 20, { multiline: true }), 'a\n\nb');
  assert.equal(clean('a\nb', 20), 'ab');
  assert.equal(clean('x'.repeat(50), 5), 'xxxxx');
  assert.equal(clean(42, 5), '');
});

test('formulaire : validation des champs', () => {
  assert.equal(checkContact(good).ok.email, 'lea@example.fr');
  assert.match(checkContact({ ...good, name: 'A' }).error, /nom/);
  assert.match(checkContact({ ...good, email: 'pas-un-mail' }).error, /e-mail/);
  assert.match(checkContact({ ...good, email: 'a@b.fr\r\nBcc: x@y.fr' }).error, /e-mail/); // pas d'injection d'en-têtes
  assert.match(checkContact({ ...good, phone: 'appelez-moi' }).error, /téléphone/);
  assert.match(checkContact({ ...good, activity: 'Spatial' }).error, /activité/);
  assert.match(checkContact({ ...good, service: 'Gratuit' }).error, /besoin/);
  for (const service of ['Pack Lancement', 'Vitrine', 'Boutique en ligne', 'Abonnement Sérénité', 'E-commerce', 'Hébergement et suivi']) assert.equal(checkContact({ ...good, service }).error, undefined, service);
  assert.match(checkContact({ ...good, timing: 'Hier' }).error, /délai/);
  assert.equal(checkContact({ ...good, phone: '', message: '' }).ok.message, '');
});

test('contact : enregistre, refuse les origines inconnues, piège à robots, doublons', async () => {
  const ok = await post('/contact', good, { ip: '2.2.2.2' });
  assert.equal(ok.status, 201);
  const overview = await (await adm('/admin/overview')).json();
  assert.equal(overview.requests.length, 1);
  assert.equal(overview.requests[0].status, 'new');
  assert.equal(overview.requests[0].email, 'lea@example.fr');
  assert.equal(JSON.stringify(overview).includes('2.2.2.2'), false); // jamais d'adresse IP enregistrée
  assert.equal((await post('/contact', good, { ip: '2.2.2.3', origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/contact', { ...good, website: 'http://spam', email: 'bot@example.fr' }, { ip: '2.2.2.4' })).status, 200); // faux succès, rien d'enregistré
  assert.equal((await post('/contact', good, { ip: '2.2.2.5' })).status, 200); // doublon récent ignoré
  assert.equal((await post('/contact', { ...good, name: 'x' }, { ip: '2.2.2.6' })).status, 422);
  assert.equal((await (await adm('/admin/overview')).json()).requests.length, 1);
  const events = readFileSync(join(dir, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['activity', 'id', 'service', 't', 'timing', 'type']); // l'alerte ne porte aucune donnée personnelle
});

test('contact : limitation de débit par adresse', async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await post('/contact', { ...good, email: `x${i}@example.fr`, message: `m${i}` }, { ip: '9.9.9.9' })).status);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429, 429]);
});

test('admin : jeton obligatoire, comparaison à temps constant, porte fermée sans fichier', async () => {
  assert.equal((await fetch(admin + '/admin/overview')).status, 401);
  assert.equal((await adm('/admin/overview', undefined, 'b'.repeat(40))).status, 401);
  assert.equal((await adm('/admin/overview')).status, 200);
  assert.equal((await fetch(admin + '/admin/overview', { headers: { 'x-admin-token': TOKEN.slice(0, 10) } })).status, 401);
  // la porte publique ne sert aucune route admin
  assert.equal((await fetch(api + '/admin/overview', { headers: { 'x-admin-token': TOKEN } })).status, 404);
  const other = createStudioService({ dataDir: join(dir, 'other'), adminTokenFile: join(dir, 'absent') });
  await other.listen(0, 0, '127.0.0.1', '127.0.0.1');
  assert.equal((await fetch(`http://127.0.0.1:${other.adminServer.address().port}/admin/overview`, { headers: { 'x-admin-token': TOKEN } })).status, 401);
  other.close();
});

test('admin : statut et note d’une demande, suppression', async () => {
  const id = (await (await adm('/admin/overview')).json()).requests[0].id;
  assert.equal((await (await adm('/admin/request', { id, status: 'quote', note: 'Devis envoyé le 21/10' })).json()).request.status, 'quote');
  assert.equal((await adm('/admin/request', { id, status: 'nimporte' })).status, 422);
  assert.equal((await adm('/admin/request', { id: 'inconnu', status: 'won' })).status, 404);
  assert.equal((await (await adm('/admin/request/delete', { id })).json()).ok, true);
  assert.equal((await (await adm('/admin/overview')).json()).requests.some((r) => r.id === id), false);
});

let link, token, pid;
test('projet : création, lien secret (jeton jamais conservé en clair), vue publique', async () => {
  const made = await (await adm('/admin/project/create', { title: 'Site de la boulangerie', client: 'Boulangerie Le Fournil' })).json();
  assert.match(made.link, /^https:\/\/studio\.glsc\.fr\/suivi\/#[0-9a-f]{32}$/);
  link = made.link; token = link.split('#')[1]; pid = made.project.id;
  assert.equal(JSON.stringify(made.project).includes(token), false);
  svc.store.saveNow();
  assert.equal(readFileSync(join(dir, 'data', 'studio.json'), 'utf8').includes(token), false); // seule l'empreinte est stockée
  const view = await (await post('/project', { token })).json();
  assert.equal(view.project.title, 'Site de la boulangerie');
  assert.deepEqual(view.project.steps.map((s) => s.state), ['current', 'todo', 'todo', 'todo', 'todo']);
  assert.equal((await post('/project', { token: 'f'.repeat(32) })).status, 404);
  assert.equal((await post('/project', { token: '../../etc/passwd' })).status, 404);
  assert.equal((await post('/project', {})).status, 404);
  assert.equal(JSON.stringify(view).includes('tokenHash'), false);
});

test('projet : étapes, messages dans les deux sens, non lus', async () => {
  await adm('/admin/project/update', { id: pid, current: 2 });
  let view = await (await post('/project', { token })).json();
  assert.deepEqual(view.project.steps.map((s) => s.state), ['done', 'done', 'current', 'todo', 'todo']);
  assert.equal((await adm('/admin/project/update', { id: pid, current: 99 })).status, 422);
  assert.equal((await post('/project/message', { token, text: '   ' })).status, 422);
  view = await (await post('/project/message', { token, text: 'Voici le logo\n<script>alert(1)</script>' })).json();
  assert.equal(view.project.messages.at(-1).from, 'client');
  assert.match(view.project.messages.at(-1).text, /<script>/); // stocké tel quel : c'est l'affichage qui échappe (textContent)
  let ov = (await (await adm('/admin/overview')).json()).projects.find((p) => p.id === pid);
  assert.equal(ov.unread, 1);
  await adm('/admin/project/message', { id: pid, text: 'Bien reçu, merci !' });
  ov = (await (await adm('/admin/overview')).json()).projects.find((p) => p.id === pid);
  assert.equal(ov.unread, 0);
  view = await (await post('/project', { token })).json();
  assert.deepEqual(view.project.messages.map((m) => m.from), ['client', 'studio']);
});

test('fichiers : type reconnu par le contenu, taille bornée, nom nettoyé, téléchargement admin seulement', async () => {
  assert.equal(sniff(Buffer.from('%PDF-1.7 ....'), 'x.exe').ext, 'pdf'); // le nom ne décide pas
  assert.equal(sniff(Buffer.from('MZ\x90\x00 fake exe......'), 'logo.png'), null);
  assert.equal(sniff(Buffer.from('PK\x03\x04 zip.........'), 'a.zip'), null);
  assert.equal(sniff(Buffer.from('PK\x03\x04 docx.......'), 'texte.docx').ext, 'docx');
  assert.equal(sniff(Buffer.from('Bonjour'), 'note.txt').ext, 'txt');
  assert.equal(sniff(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'note.txt'), null);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const send = (body, name, tok = token) => fetch(api + '/project/upload', { method: 'POST', headers: { 'x-project-token': tok, 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream', origin: ORIGIN, 'x-real-ip': '5.5.5.5' }, body });
  const ok = await send(png, '../../etc/logo final.png');
  assert.equal(ok.status, 201);
  const files = (await ok.json()).project.files;
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '.._.._etc_logo final.png'); // les séparateurs de chemin deviennent « _ »
  assert.equal(files[0].name.includes('/'), false);
  assert.equal((await send(Buffer.from('MZ\x90\x00 not allowed program'), 'virus.png')).status, 415);
  assert.equal((await send(Buffer.alloc(MAX_UPLOAD + 10, 7), 'gros.png')).status, 413);
  assert.equal((await send(png, 'x.png', 'f'.repeat(32))).status, 404);

  const ov = (await (await adm('/admin/overview')).json()).projects.find((p) => p.id === pid);
  const f = ov.files[0];
  const dl = await adm(`/admin/file/${pid}/${f.id}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.match(dl.headers.get('content-disposition'), /^attachment;/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await dl.arrayBuffer()).equals(png), true);
  assert.equal((await fetch(api + `/admin/file/${pid}/${f.id}`)).status, 404); // pas sur la porte publique
  assert.equal((await fetch(admin + `/admin/file/${pid}/${f.id}`)).status, 401);
  assert.equal(existsSync(join(dir, 'data', 'uploads', pid)), true);
  assert.equal((await adm('/admin/project/file/delete', { id: pid, file: f.id })).status, 200);
});

test('projet : nouveau lien (l’ancien meurt), clôture, suppression avec les fichiers', async () => {
  const fresh = (await (await adm('/admin/project/link', { id: pid })).json()).link.split('#')[1];
  assert.notEqual(fresh, token);
  assert.equal((await post('/project', { token })).status, 404);
  assert.equal((await post('/project', { token: fresh })).status, 200);
  assert.equal((await (await adm('/admin/project/update', { id: pid, status: 'done' })).json()).project.status, 'done');
  const view = await (await post('/project', { token: fresh })).json();
  assert.equal(view.project.steps.every((s) => s.state === 'done'), true);
  assert.equal((await adm('/admin/project/delete', { id: pid })).status, 200);
  assert.equal(existsSync(join(dir, 'data', 'uploads', pid)), false);
  assert.equal((await post('/project', { token: fresh })).status, 404);
});

test('conservation limitée : demandes et projets clos anciens supprimés', async () => {
  const old = Math.floor(Date.now() / 1000) - 400 * 86400;
  svc.store.data.requests.push({ id: 'aaaaaaaaaaaa', at: old, status: 'new', note: '', ...good });
  svc.store.data.projects.push({ id: 'bbbbbbbbbbbb', tokenHash: 'x', title: 'Ancien', client: 'X', status: 'done', closedAt: old, current: 0, steps: ['a'], createdAt: old, messages: [], files: [] });
  svc.store.data.projects.push({ id: 'cccccccccccc', tokenHash: 'y', title: 'Actif ancien', client: 'Y', status: 'active', current: 0, steps: ['a'], createdAt: old, messages: [], files: [] });
  assert.equal(svc.purge(), 2);
  const ov = await (await adm('/admin/overview')).json();
  assert.equal(ov.requests.some((r) => r.id === 'aaaaaaaaaaaa'), false);
  assert.equal(ov.projects.some((p) => p.id === 'bbbbbbbbbbbb'), false);
  assert.equal(ov.projects.some((p) => p.id === 'cccccccccccc'), true); // un projet en cours n'est jamais purgé
});
