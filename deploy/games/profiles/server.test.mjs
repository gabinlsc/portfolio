import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCrewName, checkName, createProfileService, newCrewCode, newRecoveryCode, nameKey, normalizeCode, normalizeCrewCode, parseCookie } from './server.mjs';

const ORIGIN = 'https://plus4.glsc.fr';
let svc, dir, siteDir, api, internal;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'profils-'));
  siteDir = mkdtempSync(join(tmpdir(), 'site-'));
  svc = createProfileService({ dataDir: dir, siteDir, secureCookies: true });
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

// ---------------------------------------------------------------- équipes
const get = (path, { cookie, base = api } = {}) => fetch(base + path, { headers: { ...(cookie ? { cookie } : {}) } });
const player = async (name, ip) => {
  const res = await post('/create', { name }, { ip });
  const body = await res.json();
  return { cookie: `glsc_sid=${sidOf(res)}`, pid: body.profile.pid, name };
};

test('équipes : noms et codes', () => {
  assert.ok(checkCrewName('Les Zébrés & co').name);
  for (const bad of ['a', 'x'.repeat(25), '<b>', 'bande de connards']) assert.ok(checkCrewName(bad).error, bad);
  assert.equal(checkCrewName('ok\u202eevil').name, 'okevil', 'les caractères de direction du texte sont retirés');
  const c = newCrewCode();
  assert.match(c, /^EQ(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
  assert.equal(normalizeCrewCode(c.toLowerCase().replaceAll('-', ' ')), normalizeCrewCode(c));
  assert.equal(normalizeCrewCode(c).length, 8);
});

test('équipes : créer, rejoindre avec un code approximatif, classement privé avec les statistiques de la sonde', async () => {
  const ana = await player('Crew Ana', '20.0.0.1');
  const ben = await player('Crew Ben', '20.0.0.2');
  const out = await player('Crew Out', '20.0.0.3');
  assert.equal((await post('/crews/create', { name: 'x' }, { cookie: ana.cookie })).status, 422);
  assert.equal((await post('/crews/create', { name: 'Les copains' })).status, 401);
  const created = await (await post('/crews/create', { name: 'Les copains' }, { cookie: ana.cookie })).json();
  const id = created.crew.id;
  assert.match(created.crew.code, /^EQ-/);
  assert.equal((await post('/crews/join', { code: 'EQ-0000-0000' }, { cookie: ben.cookie, ip: '20.0.1.1' })).status, 404);
  const joined = await post('/crews/join', { code: created.crew.code.toLowerCase().replaceAll('-', ' ') }, { cookie: ben.cookie, ip: '20.0.1.2' });
  assert.equal(joined.status, 200);
  // statistiques publiées par la sonde
  writeFileSync(join(siteDir, 'players.json'), JSON.stringify({ players: {
    [ana.pid]: { games: { uno: { played: 10, wins: 6, month: { played: 4, wins: 3 } }, petitbac: { played: 2, wins: 2, month: { played: 2, wins: 2 } } }, titles: [{ game: 'uno', month: '2026-09' }] },
    [ben.pid]: { games: { uno: { played: 5, wins: 1, month: { played: 1, wins: 0 } } }, titles: [] } } }));
  const detail = await (await get(`/crews/${id}`, { cookie: ben.cookie })).json();
  assert.deepEqual(detail.crew.ranking.map((r) => [r.name, r.month.wins, r.all.wins, r.titles]), [['Crew Ana', 5, 8, 1], ['Crew Ben', 0, 1, 0]]);
  assert.equal(detail.crew.ranking.find((r) => r.me).name, 'Crew Ben');
  // le classement est privé : un non-membre ne sait même pas si l'équipe existe
  assert.equal((await get(`/crews/${id}`, { cookie: out.cookie })).status, 404);
  assert.equal((await get(`/crews/${'0'.repeat(16)}`, { cookie: out.cookie })).status, 404);
  assert.equal((await get(`/crews/${id}`)).status, 401);
  assert.equal((await get('/crews', { cookie: ben.cookie }).then((r) => r.json())).crews[0].name, 'Les copains');
});

test('équipes : retirer, quitter, passer la main, supprimer, nouveau code', async () => {
  const [a, b, c] = [await player('Crew A1', '21.0.0.1'), await player('Crew B1', '21.0.0.2'), await player('Crew C1', '21.0.0.3')];
  const { crew } = await (await post('/crews/create', { name: 'Trio' }, { cookie: a.cookie })).json();
  for (const [i, p] of [b, c].entries()) assert.equal((await post('/crews/join', { code: crew.code }, { cookie: p.cookie, ip: `21.0.1.${i}` })).status, 200);
  assert.equal((await post('/crews/kick', { id: crew.id, pid: c.pid }, { cookie: b.cookie })).status, 403, 'seul le créateur retire');
  assert.equal((await post('/crews/kick', { id: crew.id, pid: a.pid }, { cookie: a.cookie })).status, 422, 'on ne se retire pas soi-même');
  assert.equal((await post('/crews/kick', { id: crew.id, pid: c.pid }, { cookie: a.cookie })).status, 200);
  assert.equal((await get(`/crews/${crew.id}`, { cookie: c.cookie })).status, 404, 'un membre retiré perd l’accès');
  // nouveau code : l'ancien ne marche plus
  const fresh = await (await post('/crews/new-code', { id: crew.id }, { cookie: a.cookie })).json();
  assert.notEqual(fresh.crew.code, crew.code);
  assert.equal((await post('/crews/join', { code: crew.code }, { cookie: c.cookie, ip: '21.0.2.1' })).status, 404);
  assert.equal((await post('/crews/new-code', { id: crew.id }, { cookie: b.cookie })).status, 404, 'réservé au créateur');
  // le créateur part : le plus ancien membre prend la suite
  assert.equal((await post('/crews/leave', { id: crew.id }, { cookie: a.cookie })).status, 200);
  const after = await (await get(`/crews/${crew.id}`, { cookie: b.cookie })).json();
  assert.equal(after.crew.owner, true);
  assert.equal((await post('/crews/delete', { id: crew.id, confirm: 'faux' }, { cookie: b.cookie })).status, 422);
  assert.equal((await post('/crews/delete', { id: crew.id, confirm: 'Trio' }, { cookie: b.cookie })).status, 200);
  assert.equal((await get('/crews', { cookie: b.cookie }).then((r) => r.json())).crews.length, 0);
});

test('équipes : limites (5 par profil, 20 membres) et suppression d’un profil', async () => {
  const boss = await player('Crew Boss', '22.0.0.1');
  for (let i = 0; i < 5; i++) assert.equal((await post('/crews/create', { name: `Equipe ${i}x` }, { cookie: boss.cookie })).status, 201);
  assert.equal((await post('/crews/create', { name: 'Sixieme' }, { cookie: boss.cookie })).status, 409);
  const crews = (await get('/crews', { cookie: boss.cookie }).then((r) => r.json())).crews;
  const full = crews[0];
  for (let i = 0; i < 19; i++) {
    const p = await player(`Membre ${i}z`, `22.1.${i}.1`);
    assert.equal((await post('/crews/join', { code: full.code }, { cookie: p.cookie, ip: `22.2.${i}.1` })).status, 200);
  }
  const late = await player('Crew Late', '22.0.0.9');
  assert.equal((await post('/crews/join', { code: full.code }, { cookie: late.cookie, ip: '22.3.0.1' })).status, 409);
  // supprimer son profil : on quitte ses équipes, la dernière personne fait disparaître l'équipe
  const solo = await player('Crew Solo', '22.0.0.10');
  const { crew } = await (await post('/crews/create', { name: 'Solo team' }, { cookie: solo.cookie })).json();
  assert.equal((await post('/delete', { confirm: 'Crew Solo' }, { cookie: solo.cookie })).status, 200);
  const owner2 = await player('Crew Boss2', '22.0.0.11');
  assert.equal((await post('/crews/join', { code: crew.code }, { cookie: owner2.cookie, ip: '22.3.0.2' })).status, 404, 'équipe disparue');
});

test('équipes : essais de code limités', async () => {
  const p = await player('Crew Brute', '23.0.0.1');
  let last;
  for (let i = 0; i < 12; i++) last = await post('/crews/join', { code: 'EQ-ZZZZ-ZZZZ' }, { cookie: p.cookie, ip: '23.9.9.9' });
  assert.equal(last.status, 429);
});

// ---------------------------------------------------------------- signalements
test('signalement : enregistré sans l’IP, avec le profil s’il y en a un, entrées nettoyées', async () => {
  const guest = await post('/report', { game: 'petitbac', message: 'La lettre ne change pas\u202e !', context: { room: 'PB-ABCD', phase: 'PLAY', page: '/?room=PB-ABCD' } }, { ip: '30.0.0.1' });
  assert.equal(guest.status, 201);
  const ana = await player('Report Ana', '30.0.0.2');
  assert.equal((await post('/report', { game: 'inconnu-jeu', message: '  Bug\n\n\n\n\nbizarre  ', context: { room: '<script>', phase: 'PLAY' } }, { cookie: ana.cookie, ip: '30.0.0.3' })).status, 201);
  const lines = readFileSync(join(dir, 'reports.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const [a, b] = lines.slice(-2);
  assert.equal(a.game, 'petitbac');
  assert.equal(a.message, 'La lettre ne change pas !', 'caractères de direction retirés');
  assert.deepEqual([a.room, a.phase], ['PB-ABCD', 'PLAY']);
  assert.ok(!('pid' in a));
  assert.equal(b.game, 'inconnu');
  assert.equal(b.message, 'Bug\n\nbizarre');
  assert.equal(b.room, undefined, 'contexte invalide ignoré');
  assert.deepEqual([b.pid, b.name], [ana.pid, 'Report Ana']);
  assert.ok(!JSON.stringify(lines).includes('30.0.0'), 'jamais l’adresse IP');
});

test('signalement : message trop court, origine inconnue, pas de flot', async () => {
  assert.equal((await post('/report', { game: 'plus4', message: 'a' }, { ip: '31.0.0.1' })).status, 422);
  assert.equal((await post('/report', { game: 'plus4', message: 'un vrai bug' }, { origin: 'https://old.glsc.fr', ip: '31.0.0.2' })).status, 403);
  let last;
  for (let i = 0; i < 7; i++) last = await post('/report', { game: 'plus4', message: `bug numéro ${i}` }, { ip: '31.0.0.3' });
  assert.equal(last.status, 429);
});

// ---------------------------------------------------------------- bot Discord
test('bot Discord : signature Ed25519, ping, /classement, /profil, /defi', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const site = mkdtempSync(join(tmpdir(), 'site-discord-'));
  const data = mkdtempSync(join(tmpdir(), 'profils-discord-'));
  writeFileSync(join(site, 'leaderboard.json'), JSON.stringify({
    daily: { text: 'Gagne une partie de +4', goal: 1 },
    games: { uno: { week: { top: [{ name: 'Léa *gras*', wins: 5, played: 9 }, { name: 'Tom', wins: 2, played: 4 }] } } },
  }));
  writeFileSync(join(site, 'players.json'), JSON.stringify({ players: {
    '0123456789abcdef': { name: 'Léa', games: { uno: { played: 9, wins: 5 } }, achievements: [{ id: 'a' }], titles: [], daily: { streak: 3 }, rivals: { nemesis: { name: 'Tom', wins: 0, losses: 3 } } },
  } }));
  const bot = createProfileService({ dataDir: data, siteDir: site, discordPublicKey: pubHex });
  const off = createProfileService({ dataDir: mkdtempSync(join(tmpdir(), 'profils-off-')), siteDir: site });
  await bot.listen(0, 0, '127.0.0.1', '127.0.0.1');
  await off.listen(0, 0, '127.0.0.1', '127.0.0.1');
  try {
    const url = `http://127.0.0.1:${bot.publicServer.address().port}/discord`;
    const call = (payload, { ts = String(Math.floor(Date.now() / 1000)), badSig = false, base = url } = {}) => {
      const body = Buffer.from(JSON.stringify(payload));
      const sig = sign(null, Buffer.concat([Buffer.from(ts), body]), privateKey).toString('hex');
      return fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': badSig ? '0'.repeat(128) : sig, 'x-signature-timestamp': ts }, body });
    };
    assert.deepEqual(await (await call({ type: 1 })).json(), { type: 1 });
    assert.equal((await call({ type: 1 }, { badSig: true })).status, 401);
    assert.equal((await call({ type: 1 }, { ts: String(Math.floor(Date.now() / 1000) - 3600) })).status, 401);
    const unsigned = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":1}' });
    assert.equal(unsigned.status, 401);
    // sans clé configurée, tout est refusé
    assert.equal((await call({ type: 1 }, { base: `http://127.0.0.1:${off.publicServer.address().port}/discord` })).status, 401);

    const top = await (await call({ type: 2, data: { name: 'classement', options: [{ name: 'jeu', value: 'uno' }, { name: 'periode', value: 'week' }] } })).json();
    assert.equal(top.type, 4);
    assert.deepEqual(top.data.allowed_mentions, { parse: [] });
    assert.match(top.data.embeds[0].description, /🥇 \*\*Léa \\\*gras\\\*\*\* · 5 victoires/);
    const bad = await (await call({ type: 2, data: { name: 'classement', options: [{ name: 'jeu', value: '__proto__' }] } })).json();
    assert.match(bad.data.embeds[0].title, /\+4/); // valeur inconnue → défaut

    const prof = await (await call({ type: 2, data: { name: 'profil', options: [{ name: 'pseudo', value: ' LEA ' }] } })).json();
    assert.match(prof.data.embeds[0].description, /9\*\* parties/);
    assert.match(prof.data.embeds[0].description, /meilleur ennemi : Tom/);
    assert.equal(prof.data.embeds[0].image.url, 'https://games.glsc.fr/cartes/0123456789abcdef.png');
    const none = await (await call({ type: 2, data: { name: 'profil', options: [{ name: 'pseudo', value: 'inconnu' }] } })).json();
    assert.equal(none.data.flags, 64);

    const daily = await (await call({ type: 2, data: { name: 'defi' } })).json();
    assert.match(daily.data.embeds[0].description, /Gagne une partie de \+4/);
  } finally { bot.close(); off.close(); rmSync(site, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
});
