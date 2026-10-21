// Génère les études de cas : projets/etudes/<slug>/index.html (publiées sur share.glsc.fr/etudes/<slug>/).
// Le contenu est ici, en données ; le gabarit est en bas. Lancer : node tools/build-etudes.mjs
// Chaque affirmation doit pouvoir se vérifier dans le code du dépôt cité : pas de chiffre inventé.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const STUDIES = [
  {
    slug: 'salle-de-jeux',
    title: 'La salle de jeux GLSC',
    color: 'banana',
    lead: 'Une petite plateforme complète autour de mes jeux : comptes, classements, déploiement automatique, sauvegardes et tableau de bord. Le tout sur un seul VPS, sans service payant.',
    stack: ['Node.js', 'Python', 'PHP', 'SQLite', 'Docker', 'Nginx', 'systemd'],
    facts: [['4', 'jeux hébergés'], ['0', 'dépendance dans le service de profils'], ['1 min', 'entre une partie et son classement']],
    links: [['Voir le code', 'https://github.com/gabinlsc/portfolio'], ['La salle de jeux', 'https://games.glsc.fr']],
    sections: [
      ['Le point de départ', [
        'J’avais des jeux qui marchaient chacun dans leur coin. Ce que je voulais, c’était que ça ressemble à un vrai service : des joueurs qui retrouvent leur pseudo, des classements, et la certitude que si je me trompe en déployant, rien ne casse pour de bon.',
        'Contrainte que je me suis donnée : un VPS modeste, des outils simples, et que je comprenne chaque pièce. Pas de base de données managée ni de plateforme clé en main.']],
      ['Les choix qui comptent', [
        ['Les jeux n’écrivent qu’une ligne par partie', 'Chaque jeu ajoute un résultat dans un fichier JSONL et c’est tout. Une sonde Python, lancée chaque minute par systemd, les range dans SQLite et calcule classements, saisons, succès et défis. Si la sonde plante, les jeux continuent ; si un jeu plante, la sonde n’y voit rien. Les deux ne se connaissent pas.'],
        ['Des profils sans mot de passe, mais sérieux', 'Un pseudo réservé, un cookie de session opaque (256 bits, HttpOnly, SameSite) dont seule l’empreinte est stockée, et un code de récupération affiché une fois. Origine vérifiée sur chaque écriture, débit limité, aucune dépendance npm : 500 lignes que je peux relire en entier. Comme les cookies sont partagés entre sous-domaines, un seul profil suit le joueur d’un jeu à l’autre.'],
        ['Déployer sans avoir peur', 'Un merge sur GitHub déclenche le déploiement : image construite, conteneur remplacé, contrôle de santé. Si le contrôle échoue, l’image précédente (étiquetée `:previous`) est remise en place toute seule. Chaque conteneur tourne en lecture seule, sans privilège noyau, avec limites de mémoire et de processus.'],
        ['Des sauvegardes que le serveur ne peut pas ouvrir', 'Les sauvegardes sont chiffrées avec age, avec la clé publique seulement : si le serveur est compromis, l’attaquant ne peut pas relire les archives. La clé privée est ailleurs, pas sur la machine.']]],
      ['Ce qui a été difficile', [
        'Les identités. Un joueur peut avoir joué sous un pseudo avant de créer un profil, puis le renommer, puis supprimer son compte. Il a fallu décider ce que devient l’historique dans chaque cas (rattaché au profil, ou effacé avec lui) et le faire de la même façon dans les classements, les fiches publiques et les cartes de partage.',
        'Tester sans prod. Beaucoup de choses (cookies de domaine, volumes Docker) ne se vérifient vraiment qu’une fois déployé. J’ai appris à isoler ce qui est testable (le service de profils a sa suite de tests) et à dire clairement ce qui ne l’est pas.']],
      ['Ce que je ferais autrement', [
        'Les salons de jeu vivent en mémoire : un redémarrage coupe les parties en cours. Pour quelques amis c’est acceptable, mais le prochain pas serait de rendre les salons reprenables.',
        'La sonde est un gros fichier Python. Elle marche et elle est testée à la main sur des jeux de données fabriqués, mais je la découperais en modules avec de vrais tests automatiques.']],
    ],
  },
  {
    slug: 'plus4',
    title: '+4, un jeu de cartes en temps réel',
    color: 'coral',
    lead: 'Un jeu de défausse façon Huit américain, jouable seul contre des bots ou à six en ligne. Le défi : des règles maison que chacun peut activer, sans que le serveur devienne un tas de cas particuliers.',
    stack: ['TypeScript', 'React', 'Framer Motion', 'Socket.IO', 'Node.js', 'Vitest', 'Playwright'],
    facts: [['240', 'tests automatisés'], ['6', 'joueurs par salon'], ['0', 'règle côté client']],
    links: [['Jouer', 'https://plus4.glsc.fr'], ['Voir le code', 'https://github.com/gabinlsc/plus4']],
    sections: [
      ['Le point de départ', [
        'Je voulais un jeu où l’on peut tricher aussi peu que possible, et où changer une règle (empiler les +2 et les +4, jouer plusieurs cartes, échanger sa main avec le 7…) ne demande pas de réécrire le jeu.']],
      ['Les choix qui comptent', [
        ['Le serveur décide, le client demande', 'Le navigateur n’envoie que des intentions (« je joue cette carte »). Le serveur vérifie, applique et renvoie à chaque joueur sa propre vue : sa main en clair, les autres réduits à ce qui est public. Un client modifié ne voit pas les mains des adversaires, parce qu’elles ne lui sont jamais envoyées.'],
        ['Un moteur pur et déterministe', 'Le moteur de règles est une bibliothèque sans réseau, avec un générateur aléatoire à graine. Mêmes entrées, même partie : c’est ce qui rend les 240 tests possibles, et ce qui m’a laissé développer les règles avant d’avoir la moindre interface.'],
        ['Les règles sont des réglages, pas du code branché partout', 'Chaque variante est une option du salon, lue à un seul endroit du moteur. Ajouter une règle revient à ajouter une option et ses tests, pas à toucher dix fichiers.'],
        ['Des bots qui ont du caractère', 'Chaque niveau de difficulté est un profil de probabilités et de temps de réaction : un bot facile oublie parfois de dire « Uno » et joue une carte au hasard, un bot fort joue stratégiquement et réagit vite. Les délais de réflexion sont volontairement irréguliers pour que ça ne ressemble pas à une machine.']]],
      ['Ce qui a été difficile', [
        'Les actions hors tour : l’interception (poser une carte identique à celle du dessus hors de son tour), la contestation d’un +4, le « Uno » oublié qu’on peut faire payer. Tout se joue à la milliseconde entre deux joueurs, donc l’état du serveur doit trancher dans un ordre clair, et le client doit rester cohérent même quand sa demande arrive trop tard.',
        'L’animation sans mentir : la carte qui vole de la main au centre ne doit jamais montrer quelque chose que le serveur n’a pas décidé.']],
      ['Ce que je ferais autrement', [
        'Les salons sont gardés en mémoire (un redémarrage les perd) et je n’ai pas de mode spectateur. Les deux se feraient sans casser l’architecture, mais je ne les ai pas encore faits.']],
    ],
  },
  {
    slug: 'president',
    title: 'Le Président, une machine à états',
    color: 'banana',
    lead: 'Le jeu de cartes du Président en ligne, de 2 à 8 joueurs. Ici le sujet, c’est la rigueur : un état de jeu qui ne peut pas devenir incohérent.',
    stack: ['TypeScript', 'Vue 3', 'Pinia', 'Tailwind CSS', 'Socket.IO', 'Zod', 'Playwright'],
    facts: [['88', 'tests'], ['5', 'phases d’une manche'], ['3', 'tailles d’écran testées']],
    links: [['Jouer', 'https://president.glsc.fr'], ['Voir le code', 'https://github.com/gabinlsc/president']],
    sections: [
      ['Le point de départ', [
        'Le Président a beaucoup de règles qui se croisent : qui peut jouer quoi, quand on est coupé, comment on échange ses cartes avec la manche d’avant. Je voulais que ces règles tiennent dans un seul endroit lisible, et qu’un coup interdit soit refusé avec la raison.']],
      ['Les choix qui comptent', [
        ['Un réducteur pur', 'Le moteur est une fonction `transition(état, action)` qui ne modifie jamais son entrée et renvoie soit le nouvel état avec ses événements, soit la règle violée. Ça se teste en trois lignes, et ça rend impossible l’état « à moitié modifié ».'],
        ['Un état par phase', 'Lobby, distribution, échanges, jeu, fin de manche : chaque phase a sa propre forme de données. Une action n’a de sens que dans la bonne phase, et le compilateur me le rappelle.'],
        ['Un client sans règles', 'Le client Vue affiche ce qu’il reçoit. Il ne sait pas ce qui est jouable : le serveur le lui dit. Les schémas Zod valident chaque message entrant, et le protocole est documenté dans le dépôt.'],
        ['Reprise de session', 'Recharger l’onglet restaure la partie. Pendant une absence, un bot joue à la place du joueur ; au retour, il récupère sa main telle qu’elle est. Quitter explicitement révoque la session.']]],
      ['Ce qui a été difficile', [
        'Le rythme des bots. Un bot qui joue instantanément est illisible ; un bot trop lent énerve. Le serveur cadence les coups pour que la table reste suivable.',
        'Les tests de bout en bout : deux navigateurs qui jouent en même temps, la reprise après rechargement, une manche solo complète. Ils tournent sur trois largeurs (1440, 390 et 320 px) et sauvegardent des captures, pour voir si l’interface tient réellement sur mobile.']],
      ['Ce que je ferais autrement', [
        'Les salons sont en mémoire, comme pour mes autres jeux. Et le moteur gagnerait à exposer l’historique des coups : il rendrait un rejeu de partie presque gratuit.']],
    ],
  },
  {
    slug: 'petit-bac',
    title: 'Petit Bac, des règles partagées',
    color: 'mint',
    lead: 'Petit Bac multijoueur sur téléphone. Le serveur tient les phases et les chronos ; les règles de score vivent dans un paquet partagé entre le serveur et le client.',
    stack: ['TypeScript', 'React', 'Socket.IO', 'Zod', 'PWA', 'pnpm workspaces'],
    facts: [['2 à 8', 'joueurs'], ['10 / 5', 'points par réponse'], ['PB-XXXX', 'code de salon']],
    links: [['Jouer', 'https://petitbac.glsc.fr'], ['Voir le code', 'https://github.com/gabinlsc/petitbac']],
    sections: [
      ['Le point de départ', [
        'C’est le jeu que j’ai écrit en dernier, avec ce que j’avais appris sur les autres : serveur autoritaire dès le premier jour, et une interface pensée d’abord pour un téléphone tenu d’une main, autour d’une table.']],
      ['Les choix qui comptent', [
        ['Un paquet partagé', 'Les constantes, les schémas Zod, le protocole et les règles pures (valider une réponse, détecter un doublon, compter les points) vivent dans un paquet commun. Le client s’en sert pour afficher, le serveur pour décider : les deux ne peuvent pas diverger.'],
        ['Des réponses secrètes jusqu’à la relecture', 'Tant que la manche dure, le serveur n’envoie à personne les réponses des autres. On ne peut pas copier son voisin, même en ouvrant les outils du navigateur.'],
        ['Un doublon, c’est subtil', 'Pour décider si deux joueurs ont donné la même réponse, on ignore les accents, la casse, le pluriel et l’article devant (« l’éléphant » vaut « éléphant »). Une réponse unique rapporte 10 points, une réponse partagée 5.'],
        ['Les joueurs jugent', 'Pendant la relecture, tout le monde voit toutes les réponses et peut refuser les douteuses. Une réponse n’est invalidée que si plus de la moitié des autres joueurs la refusent : un seul rabat-joie ne suffit pas.']],],
      ['Ce qui a été difficile', [
        'Le chrono. Le premier qui finit crie « Bac ! » et les autres ont dix secondes : c’est le serveur qui tient l’horloge et qui clôt la manche, pas les clients. Il fallait gérer en même temps les joueurs qui se déconnectent en pleine manche et le moment où le dernier vote arrive.']],
      ['Ce que je ferais autrement', [
        'La validation des mots reste humaine (le vote). Un dictionnaire embarqué aiderait à départager, mais poserait des questions de langue et de mots familiers ; je préfère laisser la table trancher, tant que c’est amusant.']],
    ],
  },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const code = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

function section([title, items]) {
  const body = items.map((it) => Array.isArray(it)
    ? `<div class="choice"><h3>${code(it[0])}</h3><p>${code(it[1])}</p></div>`
    : `<p>${code(it)}</p>`).join('\n        ');
  const wrap = items.some(Array.isArray) ? 'choices' : 'prose';
  return `      <section class="block">\n        <h2>${esc(title)}</h2>\n        <div class="${wrap}">\n        ${body}\n        </div>\n      </section>`;
}

function page(s) {
  const url = `https://share.glsc.fr/etudes/${s.slug}/`;
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'" />
  <title>${esc(s.title)} · Étude de cas</title>
  <meta name="description" content="${esc(s.lead)}" />
  <link rel="canonical" href="${url}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${esc(s.title)} · Étude de cas" />
  <meta property="og:description" content="${esc(s.lead)}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="https://glsc.fr/og.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="theme-color" content="#FFFDF0" />
  <link rel="icon" href="/_glsc/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/_glsc/favicon-32.png" sizes="32x32" type="image/png" />
  <link rel="apple-touch-icon" href="/_glsc/apple-touch-icon.png" />
  <link rel="stylesheet" href="/_glsc/fonts.css" />
  <style>
    :root { --cream: #FFFDF0; --ink: #111; --banana: #FFD84D; --mint: #7BE0AD; --lilac: #C3A6FF; --sky: #8FD3FF; --coral: #FF9478; --peach: #FFC9A8;
      --font-display: 'Fredoka', 'Arial Rounded MT Bold', system-ui, sans-serif; --font-body: 'Space Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif; --bd: 3px solid #000; --sh: 4px 4px 0 #000; }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: var(--font-body); color: var(--ink); background-color: var(--cream); background-image: radial-gradient(#00000014 1.2px, transparent 1.2px); background-size: 22px 22px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
    h1, h2, h3, p, ul { margin: 0; } ul { padding: 0; list-style: none; } a { color: inherit; }
    :focus-visible { outline: 3px dashed #000; outline-offset: 4px; }
    .wrap { max-width: 56rem; margin: 0 auto; padding: 1.25rem 1rem 4rem; }
    .back { display: inline-block; font: 700 .95rem/1 var(--font-display); text-decoration: none; background: #fff; border: var(--bd); border-radius: 999px; padding: .6rem 1rem; box-shadow: 2px 2px 0 #000; }
    .back:hover { transform: translate(1px, 1px); box-shadow: 1px 1px 0 #000; }
    header.hero { margin-top: 1.5rem; padding: 1.5rem; background: var(--${s.color}); border: var(--bd); border-radius: 1.25rem; box-shadow: 6px 6px 0 #000; }
    .eyebrow { font: 700 .8rem/1 var(--font-display); text-transform: uppercase; letter-spacing: .08em; }
    h1 { font: 700 clamp(1.9rem, 6vw, 3rem)/1.1 var(--font-display); margin: .6rem 0 .8rem; }
    .lead { font-size: 1.1rem; max-width: 42rem; }
    .stack { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: 1rem; }
    .stack span { font: 700 .8rem/1 var(--font-display); background: #fff; border: 2px solid #000; border-radius: 999px; padding: .35rem .7rem; }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 1rem; margin: 1.5rem 0; }
    .fact { background: #fff; border: var(--bd); border-radius: 1rem; box-shadow: var(--sh); padding: .9rem 1rem; }
    .fact:nth-child(2) { background: var(--sky); } .fact:nth-child(3) { background: var(--lilac); }
    .fact strong { display: block; font: 700 1.9rem/1.1 var(--font-display); }
    .fact span { font-size: .9rem; }
    .block { margin-top: 2.25rem; }
    h2 { font: 700 1.6rem/1.2 var(--font-display); margin-bottom: 1rem; }
    .prose { display: grid; gap: .9rem; max-width: 44rem; }
    .choices { display: grid; gap: 1rem; }
    .choice { background: #fff; border: var(--bd); border-radius: 1rem; box-shadow: var(--sh); padding: 1rem 1.15rem; }
    .choice:nth-child(4n+1) { background: var(--peach); } .choice:nth-child(4n+2) { background: #fff; } .choice:nth-child(4n+3) { background: var(--sky); } .choice:nth-child(4n) { background: var(--mint); }
    .choice h3 { font: 700 1.15rem/1.3 var(--font-display); margin-bottom: .35rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; background: #0000000f; border-radius: .3em; padding: .05em .3em; }
    .links { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 2.5rem; }
    .links a { font: 700 1rem/1 var(--font-display); text-decoration: none; background: var(--mint); border: var(--bd); border-radius: 999px; padding: .8rem 1.2rem; box-shadow: var(--sh); }
    .links a + a { background: #fff; }
    .links a:hover { transform: translate(2px, 2px); box-shadow: 2px 2px 0 #000; }
    nav.more { margin-top: 2.5rem; font-size: .95rem; }
    nav.more a { font-weight: 700; }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style>
</head>
<body>
  <div class="wrap">
    <a class="back" href="/">← Tous les projets</a>
    <header class="hero">
      <p class="eyebrow">Étude de cas</p>
      <h1>${esc(s.title)}</h1>
      <p class="lead">${esc(s.lead)}</p>
      <div class="stack">${s.stack.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
    </header>
    <div class="facts">
      ${s.facts.map(([v, l]) => `<div class="fact"><strong>${esc(v)}</strong><span>${esc(l)}</span></div>`).join('\n      ')}
    </div>
    <main>
${s.sections.map(section).join('\n')}
    </main>
    <div class="links">${s.links.map(([l, h]) => `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(l)}</a>`).join('')}</div>
    <nav class="more" aria-label="Autres études de cas">Autres études de cas : ${STUDIES.filter((o) => o.slug !== s.slug).map((o) => `<a href="/etudes/${o.slug}/">${esc(o.title)}</a>`).join(' · ')}</nav>
  </div>
</body>
</html>
`;
}

for (const s of STUDIES) {
  const dir = join(root, 'projets', 'etudes', s.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), page(s));
}
console.log(`${STUDIES.length} études de cas : ${STUDIES.map((s) => s.slug).join(', ')}`);
export { STUDIES };
