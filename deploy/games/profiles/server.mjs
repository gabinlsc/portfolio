// Service de profils des jeux de glsc.fr (aucune dépendance).
//
// Un profil = un pseudo réservé + un code de récupération (affiché une seule fois). Pas d'e-mail, pas de mot de passe.
// Le navigateur reçoit un cookie de session aléatoire (HttpOnly, Secure, valable sur *.glsc.fr) ; le serveur ne garde
// que l'empreinte SHA-256 du cookie et du code, jamais leur valeur.
//
// Deux écoutes :
//   publique (127.0.0.1:3300, derrière nginx sous https://games.glsc.fr/api/profile/) : créer, récupérer, lire, renommer…
//   interne  (réseau Docker, port 3301) : « identify », appelée par les serveurs de jeu pour savoir qui se connecte.
import { createServer } from 'node:http';
import { handleInteraction, makeVerifier } from './discord.mjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const COOKIE_NAME = 'glsc_sid';
const DAY = 86_400_000;
const SESSION_TTL = 400 * DAY; // plafond des navigateurs pour un cookie
const RENAME_COOLDOWN = 7 * DAY;
const MAX_SESSIONS = 10;
const MAX_BODY = 4096;
const REPORT_GAMES = new Set(['plus4', 'president', 'petitbac', 'vortex', 'site']);
const MAX_CREW_MEMBERS = 20;
const MAX_CREWS_PER_PROFILE = 5;
const CREW_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'&!-]*$/u;
export const MAX_NAME = 16; // la limite la plus basse des jeux (+4)

// ---- pseudos (même esprit que le filtre des classements, admin/collector/glsc_admin_collect.py)
const INSULTS = ['connard', 'connasse', 'salope', 'putain', 'encule', 'batard', 'bougnoul', 'nazi', 'hitler', 'fuck', 'bitch',
  'nigger', 'nigga', 'whore', 'porno', 'couille', 'merde'];
const INSULT_WORDS = new Set(['pd', 'tg', 'fdp', 'ntm', 'con', 'conne', 'pute', 'putes', 'nique', 'niquer', 'negre', 'negro', 'pede',
  'cunt', 'shit', 'chatte', 'bite', 'sex', 'sexe', 'porn', 'penis', 'ss']);
const DEFAULT_NAMES = /^(joueur|joueuse|player|invite|guest|anonyme|anonymous|moi|test|bot|hote|host|toto|admin|administrateur|modo|moderateur)\s*\d*$/;
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
// Lettres latines, chiffres, espace et quelques signes : pas d'alphabet qui imiterait un autre pseudo (« Gаbin » en cyrillique).
const NAME_RE = /^[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N} ._'-]*$/u;

/** Clé d'un pseudo, identique à name_key() de la sonde : sans accents ni majuscules, espaces réduits. */
export function nameKey(name) {
  const plain = name.normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
  return plain.toLowerCase().split(/\s+/).filter(Boolean).join(' ') || name.toLowerCase().trim();
}

/** Renvoie le pseudo nettoyé, ou { error } s'il est refusé. */
export function checkName(raw) {
  if (typeof raw !== 'string') return { error: 'Pseudo invalide.' };
  const name = raw.normalize('NFC').replace(/’/g, "'").split(/\s+/).filter(Boolean).join(' ');
  if (name.length < 2 || name.length > MAX_NAME) return { error: `Le pseudo doit faire entre 2 et ${MAX_NAME} caractères.` };
  if (!NAME_RE.test(name)) return { error: 'Lettres latines, chiffres, espaces et . _ \' - seulement.' };
  const key = nameKey(name);
  if (key.replace(/[^a-z0-9]/g, '').length < 2) return { error: 'Pseudo trop court.' };
  if (DEFAULT_NAMES.test(key) || insulting(key)) return { error: 'Ce pseudo n’est pas disponible.' };
  return { name, key };
}

function insulting(key) {
  const leet = key.replace(/[013457@$]/g, (c) => LEET[c]);
  const squashed = leet.replace(/[^a-z]/g, '');
  const words = leet.match(/[a-z]+/g) ?? [];
  return INSULTS.some((w) => squashed.includes(w)) || words.some((w) => INSULT_WORDS.has(w));
}

/** Nom d'équipe : 2 à 24 caractères, mêmes filtres d'insultes que les pseudos (mais n'importe quelle lettre). */
export function checkCrewName(raw) {
  if (typeof raw !== 'string') return { error: 'Nom invalide.' };
  const name = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/’/g, "'").split(/\s+/).filter(Boolean).join(' ');
  if (name.length < 2 || name.length > 24) return { error: 'Le nom de l’équipe doit faire entre 2 et 24 caractères.' };
  if (!CREW_NAME_RE.test(name)) return { error: 'Lettres, chiffres, espaces et . _ \' & ! - seulement.' };
  if (insulting(nameKey(name))) return { error: 'Ce nom n’est pas disponible.' };
  return { name };
}

// ---- secrets
const sha = (s) => createHash('sha256').update(s).digest('hex');
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newRecoveryCode() {
  const bytes = randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i++) out += CROCKFORD[bytes[i] & 31]; // 24 × 5 bits = 120 bits
  return 'GLSC-' + out.match(/.{4}/g).join('-');
}
/** « glsc 7k2m… » saisi n'importe comment → forme canonique (O→0, I/L→1, sans séparateurs). */
export function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return '';
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.startsWith('GLSC') ? s.slice(4) : s;
}
/** « EQ-7K2M-9XQ4 » : 40 bits, saisi n'importe comment. */
export function newCrewCode() {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += CROCKFORD[bytes[i] & 31];
  return `EQ-${out.slice(0, 4)}-${out.slice(4)}`;
}
export function normalizeCrewCode(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return '';
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.startsWith('EQ') ? s.slice(2) : s;
}
const codeHash = (raw) => sha('code:' + normalizeCode(raw));
const sidHash = (sid) => sha('sid:' + sid);
const newSid = () => randomBytes(32).toString('base64url');
const newPid = () => randomBytes(8).toString('hex');

export function parseCookie(header, name = COOKIE_NAME) {
  if (typeof header !== 'string' || header.length > 4096) return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{20,64}$/.test(v) ? v : '';
    }
  }
  return '';
}

// ---- stockage : un fichier JSON écrit de façon atomique
function loadStore(dir) {
  const file = join(dir, 'profiles.json');
  let data = { v: 1, profiles: {}, sessions: {}, keys: {} };
  if (existsSync(file)) data = { ...data, ...JSON.parse(readFileSync(file, 'utf8')) };
  let timer = null;
  const flush = () => {
    timer = null;
    mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o640 });
    renameSync(tmp, file);
  };
  return { data, flush, save() { if (!timer) timer = setTimeout(flush, 200); }, saveNow() { if (timer) clearTimeout(timer); flush(); } };
}

// ---- limitation de débit (fenêtre glissante, en mémoire)
function limiter() {
  const hits = new Map();
  return (key, max, windowMs) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 20_000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3_600_000) hits.delete(k);
    return true;
  };
}

export function createProfileService(options = {}) {
  const {
    dataDir = '/data',
    siteDir = '/site', // dossier de games.glsc.fr en lecture seule : players.json (statistiques publiées par la sonde)
    cookieDomain = '.glsc.fr',
    discordPublicKey = '', // clé publique de l'application Discord (64 hex) : sans elle, /discord refuse tout
    secureCookies = true,
    allowedOrigins = ['https://games.glsc.fr', 'https://plus4.glsc.fr', 'https://president.glsc.fr', 'https://petitbac.glsc.fr', 'https://vortex.glsc.fr'],
  } = options;
  const store = loadStore(dataDir);
  const { data } = store;
  const allow = limiter();
  const origins = new Set(allowedOrigins);

  const cookie = (sid, maxAge) =>
    `${COOKIE_NAME}=${sid}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}${cookieDomain ? `; Domain=${cookieDomain}` : ''}`;
  const publicView = (p) => ({
    pid: p.pid, name: p.name, createdAt: p.createdAt,
    canRenameAt: Math.max(0, (p.renamedAt ?? 0) + RENAME_COOLDOWN),
  });

  function startSession(pid) {
    const mine = Object.entries(data.sessions).filter(([, s]) => s.pid === pid).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    while (mine.length >= MAX_SESSIONS) delete data.sessions[mine.shift()[0]]; // on retire les plus anciennes
    const sid = newSid();
    data.sessions[sidHash(sid)] = { pid, createdAt: Date.now(), lastSeen: Date.now() };
    return sid;
  }
  function sessionOf(sid) {
    if (!sid) return null;
    const h = sidHash(sid);
    const s = data.sessions[h];
    if (!s) return null;
    const p = data.profiles[s.pid];
    if (!p || p.deleted || Date.now() - s.lastSeen > SESSION_TTL) { delete data.sessions[h]; store.save(); return null; }
    if (Date.now() - s.lastSeen > 3_600_000) { s.lastSeen = Date.now(); store.save(); }
    return { hash: h, profile: p };
  }
  const reserved = (key, exceptPid) => {
    const pid = data.keys[key];
    return pid && pid !== exceptPid ? pid : null;
  };

  // ---------------------------------------------------------------- équipes
  data.crews ??= {};
  const crewsOf = (pid) => Object.values(data.crews).filter((c) => c.members.includes(pid));
  const crewByCode = (raw) => {
    const code = normalizeCrewCode(raw);
    return code.length === 8 ? Object.values(data.crews).find((c) => c.code === code) : undefined;
  };
  const prettyCode = (c) => `EQ-${c.code.slice(0, 4)}-${c.code.slice(4)}`;
  const crewSummary = (c, pid) => ({
    id: c.id, name: c.name, owner: c.owner === pid, members: c.members.length, code: prettyCode(c),
  });
  let siteCache = { at: 0, mtime: 0, players: {} };
  /** Statistiques publiées par la sonde (players.json), relues seulement quand le fichier change. */
  function sitePlayers() {
    try {
      const file = join(siteDir, 'players.json');
      const mtime = statSync(file).mtimeMs;
      if (mtime !== siteCache.mtime) siteCache = { mtime, players: JSON.parse(readFileSync(file, 'utf8')).players ?? {} };
    } catch {
      /* pas encore publié : les équipes s'affichent sans statistiques */
    }
    return siteCache.players;
  }
  let boardCache = { mtime: 0, board: null };
  function siteBoard() {
    try {
      const file = join(siteDir, 'leaderboard.json');
      const mtime = statSync(file).mtimeMs;
      if (mtime !== boardCache.mtime) boardCache = { mtime, board: JSON.parse(readFileSync(file, 'utf8')) };
    } catch {
      /* pas encore publié */
    }
    return boardCache.board;
  }
  const verifyDiscord = makeVerifier(discordPublicKey);
  function crewDetail(c, pid) {
    const stats = sitePlayers();
    const rows = c.members.map((m) => {
      const prof = data.profiles[m];
      const fiche = stats[m];
      const sum = (pick) => Object.values(fiche?.games ?? {}).reduce((a, g) => a + (pick(g) ?? 0), 0);
      return {
        pid: m,
        name: prof?.name ?? '?',
        owner: m === c.owner,
        me: m === pid,
        month: { played: sum((g) => g.month?.played), wins: sum((g) => g.month?.wins) },
        all: { played: sum((g) => g.played), wins: sum((g) => g.wins) },
        titles: (fiche?.titles ?? []).length,
      };
    });
    return { ...crewSummary(c, pid), createdAt: c.createdAt, ranking: rows };
  }
  function leaveCrew(c, pid) {
    c.members = c.members.filter((m) => m !== pid);
    if (c.members.length === 0) delete data.crews[c.id];
    else if (c.owner === pid) c.owner = c.members[0]; // le plus ancien membre prend la suite
  }

  // ---------------------------------------------------------------- signalements de bugs
  /** Texte libre d'un joueur : sans caractères de contrôle ni de direction, au plus 2 sauts de ligne d'affilée, borné. */
  const cleanText = (raw, max) =>
    String(raw ?? '')
      .normalize('NFC')
      .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' ? '\n' : ''))
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, max);

  // ---------------------------------------------------------------- routes publiques
  const routes = {
    'GET /health': () => ({ body: { ok: true } }),
    'GET /me': (ctx) => {
      const s = sessionOf(ctx.sid);
      return { body: { profile: s ? publicView(s.profile) : null } };
    },
    'POST /create': (ctx) => {
      if (!ctx.allow('create', 5, 3_600_000) || !allow('create:all', 300, DAY)) return { status: 429, body: { error: 'Trop de créations, réessaie plus tard.' } };
      const ok = checkName(ctx.body.name);
      if (ok.error) return { status: 422, body: { error: ok.error } };
      if (reserved(ok.key)) return { status: 409, body: { error: 'Ce pseudo est déjà pris.' } };
      const code = newRecoveryCode();
      const pid = newPid();
      data.profiles[pid] = { pid, name: ok.name, key: ok.key, createdAt: Date.now(), renamedAt: 0, recovery: codeHash(code) };
      data.keys[ok.key] = pid;
      const sid = startSession(pid);
      store.saveNow();
      return { status: 201, body: { profile: publicView(data.profiles[pid]), recoveryCode: code }, setCookie: cookie(sid, SESSION_TTL / 1000) };
    },
    'POST /recover': (ctx) => {
      if (!ctx.allow('recover', 10, 900_000) || !allow('recover:all', 500, 3_600_000)) return { status: 429, body: { error: 'Trop d’essais, réessaie dans quelques minutes.' } };
      const h = codeHash(ctx.body.code);
      const p = Object.values(data.profiles).find((x) => !x.deleted && x.recovery && h.length === x.recovery.length && timingSafeEqual(Buffer.from(h), Buffer.from(x.recovery)));
      if (!p) return { status: 401, body: { error: 'Code inconnu.' } };
      const sid = startSession(p.pid);
      store.saveNow();
      return { body: { profile: publicView(p) }, setCookie: cookie(sid, SESSION_TTL / 1000) };
    },
    'POST /rename': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
      if (!ctx.allow('mutate', 30, 60_000)) return { status: 429, body: { error: 'Doucement.' } };
      const p = s.profile;
      if (Date.now() < (p.renamedAt ?? 0) + RENAME_COOLDOWN) return { status: 429, body: { error: 'Tu pourras changer de pseudo dans quelques jours.' } };
      const ok = checkName(ctx.body.name);
      if (ok.error) return { status: 422, body: { error: ok.error } };
      if (reserved(ok.key, p.pid)) return { status: 409, body: { error: 'Ce pseudo est déjà pris.' } };
      delete data.keys[p.key];
      p.name = ok.name; p.key = ok.key; p.renamedAt = Date.now();
      data.keys[ok.key] = p.pid;
      store.saveNow();
      return { body: { profile: publicView(p) } };
    },
    'POST /new-code': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
      if (!ctx.allow('mutate', 30, 60_000)) return { status: 429, body: { error: 'Doucement.' } };
      const code = newRecoveryCode();
      s.profile.recovery = codeHash(code);
      store.saveNow();
      return { body: { recoveryCode: code } };
    },
    'POST /logout': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (s) { delete data.sessions[s.hash]; store.save(); }
      return { body: { ok: true }, setCookie: cookie('', 0) };
    },
    'POST /logout-all': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
      for (const [h, x] of Object.entries(data.sessions)) if (x.pid === s.profile.pid) delete data.sessions[h];
      store.saveNow();
      return { body: { ok: true }, setCookie: cookie('', 0) };
    },
    'POST /report': (ctx) => {
      // pas besoin d'être connecté : un invité doit pouvoir signaler un bug. Mais pas de flot.
      if (!ctx.allow('report', 5, 600_000) || !allow('report:all', 300, DAY)) return { status: 429, body: { error: 'Déjà plusieurs signalements : merci, on regarde.' } };
      const message = cleanText(ctx.body.message, 600);
      if (message.length < 3) return { status: 422, body: { error: 'Décris le problème en quelques mots.' } };
      const c = ctx.body.context && typeof ctx.body.context === 'object' ? ctx.body.context : {};
      const pick = (v, re, max) => (typeof v === 'string' && re.test(v) ? v.slice(0, max) : undefined);
      const s = sessionOf(ctx.sid);
      const record = {
        t: Math.floor(Date.now() / 1000),
        game: REPORT_GAMES.has(ctx.body.game) ? ctx.body.game : 'inconnu',
        message,
        room: pick(c.room, /^[A-Za-z0-9-]{3,12}$/, 12),
        phase: pick(c.phase, /^[A-Za-z_ -]{1,24}$/, 24),
        page: pick(c.page, /^\/[\w./%-]{0,80}$/, 80),
        ua: String(ctx.ua ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 160),
        ...(s ? { pid: s.profile.pid, name: s.profile.name } : {}),
      }; // jamais l'adresse IP
      try {
        appendFileSync(join(dataDir, 'reports.jsonl'), JSON.stringify(record) + '\n', { mode: 0o640 });
      } catch {
        return { status: 500, body: { error: 'Signalement non enregistré, réessaie plus tard.' } };
      }
      return { status: 201, body: { ok: true } };
    },
    'GET /crews': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
      return { body: { crews: crewsOf(s.profile.pid).map((c) => crewSummary(c, s.profile.pid)) } };
    },
    'POST /crews/create': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
      if (!ctx.allow('crew', 20, 3_600_000)) return { status: 429, body: { error: 'Doucement.' } };
      const ok = checkCrewName(ctx.body.name);
      if (ok.error) return { status: 422, body: { error: ok.error } };
      if (crewsOf(s.profile.pid).length >= MAX_CREWS_PER_PROFILE) return { status: 409, body: { error: `Tu ne peux pas être dans plus de ${MAX_CREWS_PER_PROFILE} équipes.` } };
      let code;
      do code = normalizeCrewCode(newCrewCode());
      while (crewByCode(code));
      const id = randomBytes(8).toString('hex');
      data.crews[id] = { id, name: ok.name, code, owner: s.profile.pid, members: [s.profile.pid], createdAt: Date.now() };
      store.saveNow();
      return { status: 201, body: { crew: crewDetail(data.crews[id], s.profile.pid) } };
    },
    'POST /crews/join': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
      // 40 bits de code : on limite sévèrement les essais (par adresse, et au total)
      if (!ctx.allow('crewjoin', 10, 900_000) || !allow('crewjoin:all', 600, 3_600_000)) return { status: 429, body: { error: 'Trop d’essais, réessaie dans quelques minutes.' } };
      const c = crewByCode(ctx.body.code);
      if (!c) return { status: 404, body: { error: 'Code d’équipe inconnu.' } };
      if (c.members.includes(s.profile.pid)) return { body: { crew: crewDetail(c, s.profile.pid) } };
      if (c.members.length >= MAX_CREW_MEMBERS) return { status: 409, body: { error: `Cette équipe est complète (${MAX_CREW_MEMBERS} membres).` } };
      if (crewsOf(s.profile.pid).length >= MAX_CREWS_PER_PROFILE) return { status: 409, body: { error: `Tu ne peux pas être dans plus de ${MAX_CREWS_PER_PROFILE} équipes.` } };
      c.members.push(s.profile.pid);
      store.saveNow();
      return { body: { crew: crewDetail(c, s.profile.pid) } };
    },
    'POST /crews/leave': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
      const c = data.crews[String(ctx.body.id)];
      if (!c || !c.members.includes(s.profile.pid)) return { status: 404, body: { error: 'Équipe introuvable.' } };
      leaveCrew(c, s.profile.pid);
      store.saveNow();
      return { body: { ok: true } };
    },
    'POST /crews/kick': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
      const c = data.crews[String(ctx.body.id)];
      if (!c || !c.members.includes(s.profile.pid)) return { status: 404, body: { error: 'Équipe introuvable.' } };
      if (c.owner !== s.profile.pid) return { status: 403, body: { error: 'Seul le créateur peut retirer un membre.' } };
      const target = String(ctx.body.pid);
      if (target === s.profile.pid || !c.members.includes(target)) return { status: 422, body: { error: 'Membre invalide.' } };
      c.members = c.members.filter((m) => m !== target);
      store.saveNow();
      return { body: { crew: crewDetail(c, s.profile.pid) } };
    },
    'POST /crews/new-code': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
      const c = data.crews[String(ctx.body.id)];
      if (!c || c.owner !== s.profile.pid) return { status: 404, body: { error: 'Équipe introuvable.' } };
      do c.code = normalizeCrewCode(newCrewCode());
      while (Object.values(data.crews).some((o) => o !== c && o.code === c.code));
      store.saveNow();
      return { body: { crew: crewDetail(c, s.profile.pid) } };
    },
    'POST /crews/delete': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
      const c = data.crews[String(ctx.body.id)];
      if (!c || c.owner !== s.profile.pid) return { status: 404, body: { error: 'Équipe introuvable.' } };
      if (ctx.body.confirm !== c.name) return { status: 422, body: { error: 'Tape le nom de l’équipe pour confirmer.' } };
      delete data.crews[c.id];
      store.saveNow();
      return { body: { ok: true } };
    },
    'POST /delete': (ctx) => {
      const s = sessionOf(ctx.sid);
      if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
      if (!ctx.allow('mutate', 30, 60_000)) return { status: 429, body: { error: 'Doucement.' } };
      if (ctx.body.confirm !== s.profile.name) return { status: 422, body: { error: 'Tape ton pseudo pour confirmer.' } };
      const p = s.profile;
      for (const [h, x] of Object.entries(data.sessions)) if (x.pid === p.pid) delete data.sessions[h];
      for (const c of crewsOf(p.pid)) leaveCrew(c, p.pid);
      delete data.keys[p.key];
      data.profiles[p.pid] = { pid: p.pid, key: p.key, deleted: Date.now() }; // reste l'identifiant et la clé du pseudo : les classements ignorent ses parties
      store.saveNow();
      return { body: { ok: true }, setCookie: cookie('', 0) };
    },
  };

  function respond(res, status, body, headers = {}) {
    const text = status === 204 ? '' : JSON.stringify(body ?? {});
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(text);
  }

  async function readJson(req) {
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw Object.assign(new Error('too big'), { status: 413 });
      chunks.push(c);
    }
    if (!size) return {};
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new Error('type'), { status: 415 });
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    catch { throw Object.assign(new Error('json'), { status: 400 }); }
  }

  const publicServer = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      const known = typeof origin === 'string' && origins.has(origin);
      const cors = known ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' } : { Vary: 'Origin' };
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method === 'OPTIONS') {
        if (!known) return respond(res, 403, { error: 'Origine refusée.' });
        return respond(res, 204, {}, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
      }
      if (req.method === 'POST' && path === '/discord') {
        // Appelé par Discord (pas par un navigateur) : pas d'Origin ; l'authentification, c'est la signature Ed25519.
        const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '?').slice(0, 64);
        if (!allow(`discord:${ip}`, 120, 60_000)) return respond(res, 429, { error: 'Doucement.' });
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 16_384) return respond(res, 413, { error: 'Trop gros.' }); chunks.push(c); }
        const raw = Buffer.concat(chunks);
        if (!verifyDiscord(req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'], raw)) {
          console.error(`[profils] discord refusé : ${verifyDiscord.reason}`); // jamais la clé ni la signature
          return respond(res, 401, { error: 'Signature invalide.' });
        }
        let interaction;
        try { interaction = JSON.parse(raw.toString('utf8')); } catch { return respond(res, 400, { error: 'Requête invalide.' }); }
        return respond(res, 200, handleInteraction(interaction, () => ({ board: siteBoard(), players: sitePlayers() })));
      }
      const crewPath = req.method === 'GET' ? /^\/crews\/([0-9a-f]{16})$/.exec(path) : null;
      const handler = crewPath
        ? (ctx) => {
            const s = sessionOf(ctx.sid);
            if (!s) return { status: 401, body: { error: 'Connecte-toi d’abord.' } };
            const c = data.crews[crewPath[1]];
            // un non-membre ne doit pas pouvoir savoir si l'équipe existe
            if (!c || !c.members.includes(s.profile.pid)) return { status: 404, body: { error: 'Équipe introuvable.' } };
            return { body: { crew: crewDetail(c, s.profile.pid) } };
          }
        : routes[`${req.method} ${path}`];
      if (!handler) return respond(res, 404, { error: 'Introuvable.' }, cors);
      // Toute écriture doit venir d'une de nos pages (en plus de SameSite=Lax) ; les lectures sans origine (curl, tests) restent possibles.
      if (req.method === 'POST' && !known) return respond(res, 403, { error: 'Origine refusée.' }, cors);
      const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '?').slice(0, 64);
      const ctx = {
        sid: parseCookie(req.headers.cookie),
        ua: req.headers['user-agent'],
        body: req.method === 'POST' ? await readJson(req) : {},
        allow: (name, max, windowMs) => allow(`${name}:${ip}`, max, windowMs),
      };
      if (req.method === 'GET' && !ctx.allow('read', 240, 60_000)) return respond(res, 429, { error: 'Doucement.' }, cors);
      const out = handler(ctx);
      respond(res, out.status ?? 200, out.body, { ...cors, ...(out.setCookie ? { 'Set-Cookie': out.setCookie } : {}) });
    } catch (e) {
      respond(res, e.status ?? 500, { error: e.status ? 'Requête invalide.' : 'Erreur du serveur.' });
    }
  });

  // ---------------------------------------------------------------- écoute interne (serveurs de jeu)
  const internalServer = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method === 'GET' && path === '/health') return respond(res, 200, { ok: true });
      if (req.method !== 'POST' || path !== '/identify') return respond(res, 404, { error: 'Introuvable.' });
      const body = await readJson(req);
      const s = sessionOf(parseCookie(typeof body.cookie === 'string' ? body.cookie : ''));
      if (s) return respond(res, 200, { pid: s.profile.pid, name: s.profile.name });
      // invité : son pseudo ne doit pas être celui d'un profil
      const name = typeof body.name === 'string' ? body.name : '';
      return respond(res, 200, { pid: null, guestNameOk: !name || !reserved(nameKey(name.slice(0, 40))) });
    } catch (e) {
      respond(res, e.status ?? 500, { error: 'Requête invalide.' });
    }
  });

  return {
    publicServer, internalServer, store,
    listen(publicPort, internalPort, publicHost = '127.0.0.1', internalHost = '0.0.0.0') {
      return Promise.all([
        new Promise((r) => publicServer.listen(publicPort, publicHost, r)),
        new Promise((r) => internalServer.listen(internalPort, internalHost, r)),
      ]);
    },
    close() { store.saveNow(); publicServer.close(); internalServer.close(); },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const svc = createProfileService({
    dataDir: process.env.DATA_DIR ?? '/data',
    siteDir: process.env.SITE_DIR ?? '/site',
    cookieDomain: process.env.COOKIE_DOMAIN ?? '.glsc.fr',
    discordPublicKey: process.env.DISCORD_PUBLIC_KEY ?? '',
    secureCookies: process.env.SECURE_COOKIES !== '0',
    ...(process.env.ALLOWED_ORIGINS ? { allowedOrigins: process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  });
  await svc.listen(Number(process.env.PORT_PUBLIC ?? 3300), Number(process.env.PORT_INTERNAL ?? 3301), process.env.HOST_PUBLIC ?? '0.0.0.0');
  console.log('[profils] prêt');
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { svc.close(); process.exit(0); });
}
