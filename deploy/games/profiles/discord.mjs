// Bot Discord de la salle de jeux : commandes slash /classement, /profil et /defi.
// Discord appelle POST /api/profile/discord (« Interactions Endpoint URL ») : la requête est signée en Ed25519,
// on la vérifie avec la clé publique de l'application avant de lire quoi que ce soit. Aucune dépendance (node:crypto).
// Les réponses ne reprennent que des données déjà publiques (leaderboard.json, players.json de games.glsc.fr).
import { createPublicKey, verify } from 'node:crypto';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // en-tête DER d'une clé publique Ed25519
const MAX_AGE_S = 300;
const SITE = 'https://games.glsc.fr';
const GAMES = { uno: '+4', president: 'Le Président', petitbac: 'Petit Bac', vortex: 'Vortex' };
const PERIODS = { week: 'cette semaine', month: 'ce mois-ci', all: 'depuis toujours' };
const COLOR = 0xffd84d;

/** Renvoie (signature, horodatage, corps brut) → booléen. Sans clé valide (64 hex), tout est refusé. */
export function makeVerifier(publicKeyHex, now = () => Date.now()) {
  let key = null;
  if (typeof publicKeyHex === 'string' && /^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
    key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
  }
  const check = (signatureHex, timestamp, body) => {
    check.reason = '';
    if (!key) { check.reason = 'clé publique absente ou mal formée (64 caractères hexadécimaux attendus)'; return false; }
    if (typeof signatureHex !== 'string' || !/^[0-9a-fA-F]{128}$/.test(signatureHex)) { check.reason = 'en-tête X-Signature-Ed25519 absent ou mal formé'; return false; }
    if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) { check.reason = 'en-tête X-Signature-Timestamp absent ou mal formé'; return false; }
    const skew = Math.round(now() / 1000 - Number(timestamp));
    if (Math.abs(skew) > MAX_AGE_S) { check.reason = `horodatage hors délai (écart de ${skew} s : l'horloge du serveur est-elle à l'heure ?)`; return false; }
    try {
      const ok = verify(null, Buffer.concat([Buffer.from(timestamp), body]), key, Buffer.from(signatureHex, 'hex'));
      if (!ok) check.reason = 'la signature ne correspond pas à la clé publique configurée (clé d\'une autre application ?)';
      return ok;
    } catch {
      check.reason = 'vérification impossible';
      return false;
    }
  };
  check.reason = '';
  return check;
}

/** Neutralise le Markdown et les mentions dans un texte venant d'un joueur. */
export const plain = (s) => String(s ?? '').replace(/[\\*_~`|>@#[\]()<]/g, '\\$&').slice(0, 60);
const n = (x) => Number(x || 0).toLocaleString('fr-FR');
const keyOf = (name) => String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
const reply = (data) => ({ type: 4, data: { allowed_mentions: { parse: [] }, ...data } });
const hidden = (content) => reply({ content, flags: 64 }); // visible par l'auteur seulement
const option = (cmd, name) => cmd.options?.find((o) => o.name === name)?.value;

function leaderboardReply(cmd, board) {
  const game = Object.hasOwn(GAMES, option(cmd, 'jeu')) ? option(cmd, 'jeu') : 'uno';
  const period = Object.hasOwn(PERIODS, option(cmd, 'periode')) ? option(cmd, 'periode') : 'week';
  const top = board?.games?.[game]?.[period]?.top ?? [];
  const title = `Classement ${GAMES[game]} · ${PERIODS[period]}`;
  if (!top.length) return reply({ embeds: [{ title, color: COLOR, description: 'Personne au classement pour l’instant : à toi de jouer !', url: SITE }] });
  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.slice(0, 10).map((e, i) => {
    const score = game === 'vortex' ? `${n(e.kills)} éliminations` : `${n(e.wins)} victoire${e.wins > 1 ? 's' : ''}`;
    return `${medals[i] ?? `**${i + 1}.**`} **${plain(e.name)}** · ${score} · ${n(e.played)} partie${e.played > 1 ? 's' : ''}`;
  });
  return reply({ embeds: [{ title, color: COLOR, description: lines.join('\n'), url: SITE, footer: { text: 'games.glsc.fr' } }] });
}

function profileReply(cmd, players) {
  const wanted = keyOf(option(cmd, 'pseudo') ?? '');
  const found = wanted && Object.entries(players).find(([, p]) => keyOf(p.name) === wanted);
  if (!found) return hidden('Aucun profil public à ce nom. Crée le tien sur https://games.glsc.fr/profil/ !');
  const [pid, p] = found;
  const games = Object.entries(p.games ?? {});
  const played = games.reduce((a, [, g]) => a + (g.played || 0), 0);
  const wins = games.reduce((a, [, g]) => a + (g.wins || 0), 0);
  const fields = games.filter(([k]) => GAMES[k]).map(([k, g]) => ({ name: GAMES[k], value: `${n(g.wins)} victoire${g.wins > 1 ? 's' : ''} sur ${n(g.played)}`, inline: true }));
  const extra = [];
  if (p.daily?.streak) extra.push(`🔥 ${p.daily.streak} jour${p.daily.streak > 1 ? 's' : ''} de défi d’affilée`);
  if (p.titles?.length) extra.push(`🏅 ${p.titles.length} titre${p.titles.length > 1 ? 's' : ''} de champion`);
  if (p.rivals?.nemesis) extra.push(`😈 meilleur ennemi : ${plain(p.rivals.nemesis.name)}`);
  const card = /^[0-9a-f]{16}$/.test(pid);
  return reply({
    embeds: [{
      title: plain(p.name), color: COLOR, url: card ? `${SITE}/j/${pid}/` : SITE,
      description: [`**${n(played)}** parties · **${n(wins)}** victoires${played ? ` (${Math.round((100 * wins) / played)} %)` : ''} · **${(p.achievements ?? []).length}** succès`, ...extra].join('\n'),
      fields: fields.slice(0, 4), ...(card ? { image: { url: `${SITE}/cartes/${pid}.png` } } : {}),
    }],
  });
}

function dailyReply(board) {
  const d = board?.daily;
  if (!d) return hidden('Le défi du jour n’est pas encore publié.');
  return reply({ embeds: [{ title: 'Défi du jour', color: COLOR, description: `${plain(d.text)}.\nRelève-le avec ton profil pour faire grandir ta série !`, url: `${SITE}/profil/` }] });
}

/** Répond à une interaction déjà authentifiée. `site()` donne { board, players } (déjà lus, en cache). */
export function handleInteraction(interaction, site) {
  if (interaction?.type === 1) return { type: 1 }; // PING de Discord (validation de l'URL)
  if (interaction?.type !== 2 || !interaction.data) return hidden('Commande non prise en charge.');
  const cmd = interaction.data;
  const { board, players } = site();
  if (cmd.name === 'classement') return leaderboardReply(cmd, board);
  if (cmd.name === 'profil') return profileReply(cmd, players);
  if (cmd.name === 'defi') return dailyReply(board);
  return hidden('Commande inconnue.');
}

/** Définition des commandes (envoyée à Discord par deploy/discord/register-commands.sh). */
export const COMMANDS = [
  {
    name: 'classement', description: 'Le top 10 d’un jeu de la salle de jeux GLSC', type: 1,
    options: [
      { type: 3, name: 'jeu', description: 'Le jeu (+4 par défaut)', required: false, choices: Object.entries(GAMES).map(([value, name]) => ({ name, value })) },
      { type: 3, name: 'periode', description: 'La période (cette semaine par défaut)', required: false, choices: Object.entries(PERIODS).map(([value, name]) => ({ name, value })) },
    ],
  },
  { name: 'profil', description: 'La fiche d’un joueur', type: 1, options: [{ type: 3, name: 'pseudo', description: 'Son pseudo', required: true, max_length: 16 }] },
  { name: 'defi', description: 'Le défi du jour', type: 1 },
];
