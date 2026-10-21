"""Cartes de profil partageables (PNG 1200×630) et pages de partage avec aperçu (Open Graph).

Appelé par la sonde (glsc_admin_collect.py) : une carte n'est redessinée que si les chiffres du profil ont changé.
Dépendance : Pillow (paquet python3-pil). Sans Pillow, la sonde saute simplement cette étape.
Polices : Fredoka et Space Grotesk (licence OFL), converties en TTF dans deploy/games/cards/fonts."""
import datetime as dt
import hashlib
import html
import json
import os
import re
import unicodedata

from PIL import Image, ImageDraw, ImageFont  # absent → ImportError : la sonde saute l'étape

PID_RE = re.compile(r"^[0-9a-f]{16}$")
W, H = 1200, 630
INK, CREAM = (17, 17, 17), (255, 253, 240)
COLORS = {"banana": (255, 216, 77), "mint": (123, 224, 173), "lilac": (195, 166, 255), "sky": (143, 211, 255),
          "coral": (255, 148, 120), "peach": (255, 201, 168), "pink": (255, 179, 217)}
GAMES = {"uno": "+4", "president": "Le Président", "petitbac": "Petit Bac", "vortex": "Vortex"}
MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
SITE = "https://games.glsc.fr"


def clean(text):
    """Pillow dessine un carré pour un caractère absent de la police : on ramène ces caractères à de l'ASCII."""
    out = []
    for ch in unicodedata.normalize("NFC", str(text)):
        if ord(ch) <= 0x24F:
            out.append(ch)
        else:
            plain = unicodedata.normalize("NFKD", ch).encode("ascii", "ignore").decode()
            out.append(plain or "?")
    return "".join(out)


def summary(entry):
    """Chiffres affichés sur la carte, tirés d'une fiche de players.json."""
    games = entry.get("games", {})
    played = sum(g.get("played", 0) for g in games.values())
    wins = sum(g.get("wins", 0) for g in games.values())
    favourite = max(games, key=lambda k: games[k].get("played", 0)) if games else None
    since = dt.datetime.fromtimestamp(entry.get("since", 0), dt.timezone.utc)
    return {"name": entry["name"], "played": played, "wins": wins, "rate": round(100 * wins / played) if played else 0,
            "achievements": len(entry.get("achievements", [])), "titles": len(entry.get("titles", [])),
            "streak": (entry.get("daily") or {}).get("streak", 0), "favourite": favourite,
            "since": f"{MONTHS[since.month - 1]} {since.year}"}


def fingerprint(s):
    return hashlib.sha1(json.dumps(s, sort_keys=True).encode()).hexdigest()[:12]


def render(s, fonts_dir):
    """Dessine la carte et renvoie l'image Pillow."""
    def font(name, size):
        return ImageFont.truetype(os.path.join(fonts_dir, name), size)

    title, strong, body, bold = (font("fredoka-latin-700-normal.ttf", 112), font("fredoka-latin-600-normal.ttf", 64),
                                 font("space-grotesk-latin-500-normal.ttf", 30), font("space-grotesk-latin-700-normal.ttf", 30))
    img = Image.new("RGB", (W, H), COLORS["banana"])
    d = ImageDraw.Draw(img)

    def box(xy, color, shadow=8, width=5):
        x0, y0, x1, y1 = xy
        d.rectangle((x0 + shadow, y0 + shadow, x1 + shadow, y1 + shadow), fill=INK)
        d.rectangle(xy, fill=color, outline=INK, width=width)

    d.rectangle((0, 0, W - 1, H - 1), outline=INK, width=10)
    box((50, 46, 520, 100), CREAM, shadow=6, width=4)
    d.text((72, 56), "GLSC · SALLE DE JEUX", font=bold, fill=INK)

    name = clean(s["name"])
    size = 112
    while size > 56 and d.textlength(name, font=font("fredoka-latin-700-normal.ttf", size)) > W - 140:
        size -= 6
    d.text((60, 118), name, font=font("fredoka-latin-700-normal.ttf", size), fill=INK)
    d.text((64, 118 + size + 14), f"joueur depuis {s['since']}", font=body, fill=INK)

    tiles = [("parties", s["played"], "sky"), ("victoires", s["wins"], "mint"),
             ("% de victoires", f"{s['rate']} %", "lilac"), ("succès", s["achievements"], "coral")]
    tw, gap, y0 = 250, 28, 318
    for i, (label, value, color) in enumerate(tiles):
        x0 = 60 + i * (tw + gap)
        box((x0, y0, x0 + tw, y0 + 150), COLORS[color])
        d.text((x0 + 22, y0 + 18), str(value), font=strong, fill=INK)
        d.text((x0 + 22, y0 + 100), label, font=bold, fill=INK)

    bits = []
    if s["favourite"]:
        bits.append(f"Jeu préféré : {GAMES.get(s['favourite'], s['favourite'])}")
    if s["streak"]:
        bits.append(f"{s['streak']} jour{'s' if s['streak'] > 1 else ''} de défi d'affilée")
    if s["titles"]:
        bits.append(f"{s['titles']} titre{'s' if s['titles'] > 1 else ''} de champion")
    box((60, 494, 1140, 550), CREAM, shadow=6, width=4)
    d.text((82, 507), "  ·  ".join(bits) or "Viens jouer avec moi !", font=bold, fill=INK)
    d.text((W - 60 - d.textlength("games.glsc.fr", font=bold), 570), "games.glsc.fr", font=bold, fill=INK)
    return img


def share_page(pid, s):
    """Page de partage : aperçu Open Graph (Discord, WhatsApp…) puis lien vers la salle de jeux."""
    name = html.escape(clean(s["name"]))
    desc = html.escape(f"{s['played']} parties, {s['wins']} victoires ({s['rate']} %), {s['achievements']} succès sur la salle de jeux GLSC.")
    img = f"{SITE}/cartes/{pid}.png"
    url = f"{SITE}/j/{pid}/"
    return f"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} · Salle de jeux GLSC</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{url}">
<link rel="icon" href="/_glsc/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/_glsc/apple-touch-icon.png">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="GLSC · Salle de jeux">
<meta property="og:title" content="{name} sur la salle de jeux GLSC">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{img}">
<meta property="og:image:width" content="{W}">
<meta property="og:image:height" content="{H}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{img}">
<meta name="robots" content="noindex">
<style>
  body {{ margin: 0; background: #FFD84D; color: #111; font-family: system-ui, sans-serif; display: grid; min-height: 100vh; place-items: center; padding: 16px; box-sizing: border-box; }}
  main {{ max-width: 640px; text-align: center; }}
  img {{ width: 100%; height: auto; border: 4px solid #111; box-shadow: 8px 8px 0 #111; background: #FFFDF0; }}
  a.btn {{ display: inline-block; margin-top: 28px; padding: 12px 22px; background: #7BE0AD; color: #111; border: 4px solid #111; box-shadow: 5px 5px 0 #111; font-weight: 700; text-decoration: none; }}
</style>
</head>
<body>
<main>
<img src="/cartes/{pid}.png" width="{W}" height="{H}" alt="Carte de profil de {name}">
<p><a class="btn" href="/">Jouer avec {name} →</a></p>
</main>
</body>
</html>
"""


def publish(players, root, fonts_dir, state, limit=40):
    """Écrit cartes/<pid>.png et j/<pid>/index.html pour chaque profil public dont les chiffres ont changé ; efface celles des profils partis.
    `state` (dict conservé par la sonde) retient l'empreinte de chaque carte. Au plus `limit` cartes par passage (le reste suit à la minute suivante). Renvoie le nombre de cartes redessinées."""
    cards, shares = os.path.join(root, "cartes"), os.path.join(root, "j")
    os.makedirs(cards, mode=0o755, exist_ok=True)
    os.makedirs(shares, mode=0o755, exist_ok=True)
    done = 0
    wanted = {pid: summary(e) for pid, e in players.items() if PID_RE.match(pid)}
    for pid, s in wanted.items():
        fp = fingerprint(s)
        png = os.path.join(cards, pid + ".png")
        if state.get(pid) == fp and os.path.exists(png):
            continue
        if done >= limit:
            break
        img = render(s, fonts_dir)
        tmp = png + ".tmp"
        img.save(tmp, "PNG", optimize=True)
        os.chmod(tmp, 0o644)
        os.replace(tmp, png)
        d = os.path.join(shares, pid)
        os.makedirs(d, mode=0o755, exist_ok=True)
        with open(os.path.join(d, "index.html.tmp"), "w", encoding="utf-8") as f:
            f.write(share_page(pid, s))
        os.chmod(os.path.join(d, "index.html.tmp"), 0o644)
        os.replace(os.path.join(d, "index.html.tmp"), os.path.join(d, "index.html"))
        state[pid] = fp
        done += 1
    for pid in [k for k in state if k not in wanted]:
        state.pop(pid, None)
    for name in os.listdir(cards):
        if name.endswith(".png") and name[:-4] not in wanted and PID_RE.match(name[:-4]):
            os.unlink(os.path.join(cards, name))
    for name in os.listdir(shares):
        pid_dir = os.path.join(shares, name)
        if PID_RE.match(name) and name not in wanted and os.path.isdir(pid_dir):
            for f in os.listdir(pid_dir):
                os.unlink(os.path.join(pid_dir, f))
            os.rmdir(pid_dir)
    return done
