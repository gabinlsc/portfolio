import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkName, createProfileService, newRecoveryCode, nameKey, normalizeCode, parseCookie } from './server.mjs';

const ORIGIN = 'https://plus4.glsc.fr';
let svc, dir, api, internal;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'profils-'));
  svc = createProfileService({ dataDir: dir, secureCookies: true });
  await svc.listen(0, 0, '127.0.0.1', '127.0.0.1');
  api = `http://127.0.0.1:${svc.publicServer.address().port}`;
  internal = `http://127.0.0.1:${svc.internalServer.address().port}`;
});
after(() => { svc.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, { cookie, origin = ORIGIN, ip = '1.1.1.1', base = api } = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), 'x-real-ip': ip },
    body: JSON.stringify(body),
  });
const sidOf = (res) => /glsc_sid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';

test('pseudos : clé identique à la sonde, filtres, alphabets', () => {
  assert.equal(nameKey('  Éléa   Dupont '), 'elea dupont');
  assert.equal(nameKey('GABIN'), 'gabin');
  assert.ok(checkName('Éléa').name);
  assert.equal(checkName('L’as').name, "L'as", 'apostrophe typographique → ASCII (les jeux n’acceptent que celle-là)');
  for (const bad of ['a', 'x'.repeat(17), 'Joueur 2', 'Admin', 'conn4rd', 'Gаbin' /* a cyrillique */, '<b>x</b>', 'ok‮evil', 'a​b']) {
    assert.ok(checkName(bad).error, `devrait refuser « ${bad} »`);
  }
});

test('code de récupération : forme et normalisation', () => {
  const c = newRecoveryCode();
  assert.match(c, /^GLSC(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
  assert.equal(normalizeCode(c.toLowerCase().replaceAll('-', ' ')), normalizeCode(c));
  assert.notEqual(newRecoveryCode(), c);
});

test('cookie : seule une valeur bien formée est lue', () => {
  assert.equal(parseCookie('a=1; glsc_sid=' + 'A'.repeat(43)), 'A'.repeat(43));
  assert.equal(parseCookie('glsc_sid=court'), '');
  assert.equal(parseCookie('glsc_sid=' + 'é'.repeat(30)), '');
});

let sid, code;
test('création : cookie durci, code affiché une fois, rien de secret sur le disque', async () => {
  const res = await post('/create', { name: 'Gabin' });
  assert.equal(res.status, 201);
  const setCookie = res.headers.get('set-cookie');
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Domain=.glsc.fr', 'Path=/']) assert.ok(setCookie.includes(attr), attr);
  const body = await res.json();
  assert.equal(body.profile.name, 'Gabin');
  code = body.recoveryCode;
  sid = sidOf(res);
  assert.match(code, /^GLSC-/);
  svc.store.saveNow();
  const disk = readFileSync(join(dir, 'profiles.json'), 'utf8');
  assert.ok(!disk.includes(sid), 'le cookie ne doit pas être stocké en clair');
  assert.ok(!disk.includes(normalizeCode(code)), 'le code ne doit pas être stocké en clair');
});

test('pseudo réservé : refus, même avec une autre casse ou des accents', async () => {
  for (const name of ['Gabin', 'gabin', 'GABIN', 'Gabín']) {
    const res = await post('/create', { name }, { ip: '2.2.2.2' });
    assert.equal(res.status, 409, name);
  }
});

test('lecture du profil avec le cookie', async () => {
  const me = await (await fetch(api + '/me', { headers: { cookie: `glsc_sid=${sid}`, origin: ORIGIN } })).json();
  assert.equal(me.profile.name, 'Gabin');
  const anon = await (await fetch(api + '/me')).json();
  assert.equal(anon.profile, null);
  const forged = await (await fetch(api + '/me', { headers: { cookie: 'glsc_sid=' + 'A'.repeat(43) } })).json();
  assert.equal(forged.profile, null);
});

test('CORS : seules nos pages, avec cookies ; écriture refusée sans origine connue', async () => {
  const ok = await fetch(api + '/me', { headers: { origin: ORIGIN } });
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  const other = await fetch(api + '/me', { headers: { origin: 'https://old.glsc.fr' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  assert.equal((await post('/create', { name: 'Pirate' }, { origin: 'https://old.glsc.fr', ip: '3.3.3.3' })).status, 403);
  assert.equal((await post('/create', { name: 'Pirate' }, { origin: null, ip: '3.3.3.3' })).status, 403);
  const pre = await fetch(api + '/create', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(pre.status, 403);
});

test('récupération : le bon code ouvre une session, un mauvais non, avec limitation', async () => {
  const good = await post('/recover', { code: code.toLowerCase().replaceAll('-', ' ') }, { ip: '4.4.4.4' });
  assert.equal(good.status, 200);
  assert.ok(sidOf(good) && sidOf(good) !== sid);
  assert.equal((await post('/recover', { code: 'GLSC-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' }, { ip: '5.5.5.5' })).status, 401);
  assert.equal((await post('/recover', { code: 42 }, { ip: '5.5.5.5' })).status, 401);
  let last;
  for (let i = 0; i < 12; i++) last = await post('/recover', { code: 'GLSC-BBBB-BBBB-BBBB-BBBB-BBBB-BBBB' }, { ip: '6.6.6.6' });
  assert.equal(last.status, 429);
});

test('invité : pseudo de profil interdit, cookie valide reconnu (écoute interne)', async () => {
  const known = await (await post('/identify', { cookie: `glsc_sid=${sid}`, name: 'Autre' }, { origin: null, base: internal })).json();
  assert.deepEqual(known, { pid: known.pid, name: 'Gabin' });
  const guestTaken = await (await post('/identify', { cookie: '', name: 'gabin' }, { origin: null, base: internal })).json();
  assert.equal(guestTaken.pid, null);
  assert.equal(guestTaken.guestNameOk, false);
  const guestFree = await (await post('/identify', { cookie: 'glsc_sid=' + 'B'.repeat(43), name: 'Léa' }, { origin: null, base: internal })).json();
  assert.equal(guestFree.guestNameOk, true);
  assert.equal((await fetch(internal + '/me')).status, 404, 'les routes publiques ne sont pas sur l’écoute interne');
  assert.equal((await fetch(api + '/identify', { method: 'POST' })).status, 404, 'identify n’est pas sur l’écoute publique');
});

test('renommer : cooldown, unicité', async () => {
  const other = await post('/create', { name: 'Léa' }, { ip: '7.7.7.7' });
  assert.equal(other.status, 201);
  const sid2 = sidOf(other);
  assert.equal((await post('/rename', { name: 'Gabin' }, { cookie: `glsc_sid=${sid2}` })).status, 409);
  assert.equal((await post('/rename', { name: 'Léa 2' }, { cookie: `glsc_sid=${sid2}` })).status, 200);
  assert.equal((await post('/rename', { name: 'Léa 3' }, { cookie: `glsc_sid=${sid2}` })).status, 429);
  assert.equal((await post('/create', { name: 'Léa' }, { ip: '8.8.8.8' })).status, 201, 'l’ancien pseudo est libéré');
});

test('nouveau code : l’ancien ne marche plus', async () => {
  const res = await (await post('/new-code', {}, { cookie: `glsc_sid=${sid}` })).json();
  assert.notEqual(res.recoveryCode, code);
  assert.equal((await post('/recover', { code }, { ip: '9.9.9.9' })).status, 401);
  assert.equal((await post('/recover', { code: res.recoveryCode }, { ip: '9.9.9.9' })).status, 200);
});

test('déconnexion de tous les appareils', async () => {
  const again = await post('/recover', { code: (await (await post('/new-code', {}, { cookie: `glsc_sid=${sid}` })).json()).recoveryCode }, { ip: '10.0.0.1' });
  const sidB = sidOf(again);
  assert.equal((await post('/logout-all', {}, { cookie: `glsc_sid=${sidB}` })).status, 200);
  for (const s of [sid, sidB]) assert.equal((await (await fetch(api + '/me', { headers: { cookie: `glsc_sid=${s}` } })).json()).profile, null);
});

test('suppression : demande le pseudo, efface la session, libère le pseudo', async () => {
  const created = await post('/create', { name: 'Éphémère' }, { ip: '11.0.0.1' });
  const s = sidOf(created);
  assert.equal((await post('/delete', { confirm: 'autre' }, { cookie: `glsc_sid=${s}` })).status, 422);
  assert.equal((await post('/delete', { confirm: 'Éphémère' }, { cookie: `glsc_sid=${s}` })).status, 200);
  assert.equal((await (await fetch(api + '/me', { headers: { cookie: `glsc_sid=${s}` } })).json()).profile, null);
  const file = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8'));
  const gone = Object.values(file.profiles).find((p) => p.deleted);
  assert.deepEqual(Object.keys(gone).sort(), ['deleted', 'key', 'pid'], 'il ne reste que l’identifiant et la clé du pseudo');
  assert.ok(!JSON.stringify(gone).includes('Éphémère') && !JSON.stringify(gone).includes('recovery'));
  assert.equal((await post('/create', { name: 'Éphémère' }, { ip: '11.0.0.2' })).status, 201);
});

test('entrées abusives : trop gros, mauvais type, JSON cassé', async () => {
  assert.equal((await post('/create', { name: 'x'.repeat(5000) }, { ip: '12.0.0.1' })).status, 413);
  const wrongType = await fetch(api + '/create', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'text/plain', 'x-real-ip': '12.0.0.2' }, body: 'name=a' });
  assert.equal(wrongType.status, 415);
  const broken = await fetch(api + '/create', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-real-ip': '12.0.0.3' }, body: '{' });
  assert.equal(broken.status, 400);
  assert.equal((await post('/create', { name: { $ne: 1 } }, { ip: '12.0.0.4' })).status, 422);
});

test('création : limitation par adresse', async () => {
  let last;
  for (let i = 0; i < 7; i++) last = await post('/create', { name: `Spam ${i}x` }, { ip: '13.0.0.1' });
  assert.equal(last.status, 429);
});
