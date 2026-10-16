#!/usr/bin/env python3
"""
glsc-admin-collect — sonde root de admin.glsc.fr (aucune dépendance hors Python 3).

  collect   (chaque minute, glsc-admin-collect.timer)
    1. lit les nouvelles lignes du log nginx JSON (/var/log/nginx/glsc-access.log) → table requests ;
    2. mesure le serveur (CPU, mémoire, disque, services, certificats, processus) → health.json + table health ;
    3. état des conteneurs de jeux et joueurs connectés → docker.json + table games ;
       résultats des parties (/var/lib/glsc-games/<jeu>/results.jsonl) → table results + classements ;
    4. tentatives SSH (journald) et fail2ban → table ssh + security.json ;
    5. GitHub (toutes les 15 min) et sauvegardes/versions (toutes les 10 min) → github.json, deploys.json ;
    6. envoie les alertes Discord (si un webhook est réglé dans l'admin) ;
    7. publie une copie figée de la base (metrics.db) lisible par www-data.
  queue     (déclenché par glsc-admin-queue.path dès qu'un fichier arrive)
    traite les demandes de l'admin : message Discord, redémarrage d'un jeu (liste blanche).
  recap     (commande glsc-recap, ou bouton de l'admin via la file d'attente)
    envoie tout de suite le récap Discord des 7 derniers jours (--semaine : semaine dernière ; --apercu : sans envoyer).
    Le récap de la semaine écoulée part aussi tout seul le lundi à 9 h (collect).
  backup    (chaque nuit, glsc-backup.timer ; ou bouton de l'admin)
    archive la base de l'admin, les classements, les identifiants, la config nginx et les certificats,
    la chiffre avec la clé PUBLIQUE de /etc/glsc-backup/recipient (age : le serveur ne peut pas la rouvrir),
    la garde en local (/var/backups/glsc) et l'envoie hors du serveur (rclone ou Discord). État : backup.json.
  deploy    (déclenché par glsc-deploy.path : push sur main ou bouton de l'admin)
    télécharge le dépôt et lance les scripts de déploiement prévus pour la cible (liste blanche),
    publie l'historique (deploy-runs.json), les journaux (deploy-logs/) et prévient sur Discord.

L'admin web (www-data) ne fait que LIRE ce qui est publié ; elle n'a aucun droit sur Docker ni sur les logs.
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Paris")
GAMES = {  # service compose → (nom affiché, port local, domaine)
    "uno": ("+4", 3101, "plus4.glsc.fr"),  # « uno » : identifiant interne de +4 (service Docker, résultats)
    "president": ("Le Président", 3102, "president.glsc.fr"),
    "petitbac": ("Petit Bac", 3104, "petitbac.glsc.fr"),
    "vortex": ("Vortex", 3103, "vortex.glsc.fr"),
}
SERVICES = [  # unité systemd → libellé
    ("nginx.service", "Serveur web (nginx)"), ("php-fpm", "PHP"), ("docker.service", "Docker"),
    ("ssh.service", "SSH"), ("fail2ban.service", "fail2ban"), ("cron.service", "Tâches planifiées (cron)"),
    ("certbot.timer", "Renouvellement HTTPS (certbot)"), ("glsc-status.timer", "Sonde status.glsc.fr"),
    ("glsc-admin-collect.timer", "Sonde de l'admin"),
]
STATIC_EXT = re.compile(r"\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|json|xml|txt|webmanifest|mp4|webm|pdf|zip)$", re.I)
BOT_UA = re.compile(r"bot|crawl|spider|slurp|curl|wget|python|httpclient|preview|facebookexternalhit|discord|whatsapp|go-http|okhttp|java/|libwww|scan|headless|zgrab|masscan|nmap|nuclei|httpx", re.I)
SCAN_PATH = re.compile(
    r"(wp-(login|admin|content|includes|json)|xmlrpc\.php|/\.env|/\.git|/\.aws|/\.ssh|/\.svn|/\.DS_Store|phpmyadmin|/pma/|/myadmin|"
    r"cgi-bin|/vendor/phpunit|eval-stdin|/actuator|/boaform|/HNAP1|/solr|/owa/|/autodiscover|/\.well-known/security|"
    r"/server-status|/config\.(json|php|yml)|/setup\.php|/install\.php|/shell|/backup|\.sql$|\.bak$|\.old$|/telescope|/debug|/console|"
    r"/geoserver|/manager/html|/jenkins|/druid|/hudson|\.php7?$)", re.I)
PAGE_SKIP = re.compile(r"^/(_glsc/|api/|socket\.io|assets/|f/)")
NO_PAGE_HOSTS = {"admin.glsc.fr", "click.glsc.fr"}


def log(*a):
    print("[glsc-admin]", *a, file=sys.stderr, flush=True)


def run(cmd, timeout=20):
    """Commande système → texte (vide si absente ou en échec)."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def write_json(path, data, group_gid=None, mode=0o640):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.chmod(tmp, mode)
    if group_gid is not None:
        try:
            os.chown(tmp, 0, group_gid)
        except PermissionError:
            pass
    os.replace(tmp, path)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


# ---------------------------------------------------------------- base de travail
SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (ts INTEGER NOT NULL, day TEXT NOT NULL, host TEXT NOT NULL, ip TEXT NOT NULL, status INTEGER NOT NULL,
  method TEXT NOT NULL, path TEXT NOT NULL, query TEXT NOT NULL, bytes INTEGER NOT NULL, referer TEXT NOT NULL, ua TEXT NOT NULL,
  device TEXT NOT NULL, bot INTEGER NOT NULL, page INTEGER NOT NULL, scan INTEGER NOT NULL, lang TEXT NOT NULL, rt REAL NOT NULL);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_host_ts ON requests(host, ts);
CREATE TABLE IF NOT EXISTS health (ts INTEGER PRIMARY KEY, cpu REAL, mem_used INTEGER, mem_total INTEGER, swap_used INTEGER, swap_total INTEGER,
  disk_used INTEGER, disk_total INTEGER, load1 REAL);
CREATE TABLE IF NOT EXISTS games (ts INTEGER NOT NULL, game TEXT NOT NULL, conns INTEGER NOT NULL, cpu REAL, mem INTEGER);
CREATE INDEX IF NOT EXISTS games_ts ON games(ts);
CREATE TABLE IF NOT EXISTS ssh (ts INTEGER NOT NULL, ip TEXT NOT NULL, user TEXT NOT NULL, kind TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ssh_ts ON ssh(ts);
CREATE TABLE IF NOT EXISTS results (ts INTEGER NOT NULL, game TEXT NOT NULL, match TEXT NOT NULL, mode TEXT NOT NULL, name TEXT NOT NULL,
  key TEXT NOT NULL, rank INTEGER NOT NULL, won INTEGER NOT NULL, role TEXT, kills INTEGER, deaths INTEGER, assists INTEGER, pid TEXT);
CREATE INDEX IF NOT EXISTS results_game_ts ON results(game, ts);
"""


def device_of(ua):
    if not ua or BOT_UA.search(ua):
        return "robot"
    if re.search(r"ipad|tablet", ua, re.I):
        return "tablette"
    if re.search(r"mobi|android|iphone", ua, re.I):
        return "mobile"
    return "ordinateur"


def parse_line(line):
    """Une ligne du log nginx (format glsc_json) → tuple pour la table requests, ou None."""
    try:
        r = json.loads(line)
        ts = int(dt.datetime.fromisoformat(r["t"]).timestamp())
    except (ValueError, KeyError, TypeError):
        return None
    uri = str(r.get("u", ""))[:2000]
    path, _, query = uri.partition("?")
    path = path[:300] or "/"
    host = str(r.get("h", "")).lower()[:80]
    ua = str(r.get("a", ""))[:300]
    status = int(r.get("s") or 0)
    method = str(r.get("m", ""))[:10]
    scan = 1 if SCAN_PATH.search(path) else 0
    device = device_of(ua)
    bot = 1 if device == "robot" or scan else 0
    page = int(method == "GET" and status in (200, 304) and not bot and host not in NO_PAGE_HOSTS
               and not STATIC_EXT.search(path) and not PAGE_SKIP.search(path))
    lang = str(r.get("l", ""))[:2].lower() if r.get("l") else ""
    if not re.fullmatch(r"[a-z]{2}", lang):
        lang = ""
    ref = str(r.get("r", ""))[:300]
    day = dt.datetime.fromtimestamp(ts, TZ).strftime("%Y-%m-%d")
    try:
        rt = float(r.get("rt") or 0)
    except ValueError:
        rt = 0.0
    return (ts, day, host, str(r.get("ip", ""))[:45], status, method, path, query[:300], int(r.get("b") or 0), ref, ua,
            device, bot, page, scan, lang, rt)


def ingest_log(db, state, logfile, max_lines=300000):
    """Lit les lignes ajoutées depuis le dernier passage, y compris la fin d'un fichier qui vient d'être archivé (.1)."""
    pos = state.setdefault("log", {"inode": None, "offset": 0})
    try:
        st = os.stat(logfile)
    except OSError:
        return 0
    rows = []

    def read(path, offset):
        with open(path, "rb") as f:
            f.seek(offset)
            for raw in f:
                if not raw.endswith(b"\n"):
                    break  # ligne en cours d'écriture : on la lira au prochain passage
                offset += len(raw)
                row = parse_line(raw.decode("utf-8", "replace"))
                if row:
                    rows.append(row)
                if len(rows) >= max_lines:
                    break
        return offset

    if pos["inode"] != st.st_ino:
        rotated = logfile + ".1"
        if pos["inode"] is not None and os.path.exists(rotated) and os.stat(rotated).st_ino == pos["inode"]:
            read(rotated, pos["offset"])
        pos["inode"], pos["offset"] = st.st_ino, 0
    if st.st_size < pos["offset"]:
        pos["offset"] = 0  # fichier tronqué
    pos["offset"] = read(logfile, pos["offset"])
    if rows:
        db.executemany("INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


# ---------------------------------------------------------------- santé
def cpu_percent(state):
    with open("/proc/stat") as f:
        vals = [int(x) for x in f.readline().split()[1:]]
    idle, total = vals[3] + (vals[4] if len(vals) > 4 else 0), sum(vals)
    prev = state.get("cpu")
    state["cpu"] = [idle, total]
    if not prev or total == prev[1]:
        return 0.0
    return max(0.0, min(100.0, 100.0 * (1 - (idle - prev[0]) / (total - prev[1]))))


def meminfo():
    m = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            m[k] = int(v.split()[0]) * 1024
    return m


def unit_state(name):
    """(présent, actif) pour une unité systemd ; « php-fpm » trouve la bonne version de PHP."""
    if name == "php-fpm":
        units = re.findall(r"(php[\d.]*-fpm\.service)", run(["systemctl", "list-unit-files", "php*-fpm.service", "--no-legend"]))
        if not units:
            return name, False, False
        name = units[-1]
    present = bool(run(["systemctl", "list-unit-files", name, "--no-legend"]).strip())
    active = run(["systemctl", "is-active", name]).strip() == "active"
    return name, present, active


def cert_list(live_dir):
    out = []
    for cert in sorted(glob.glob(os.path.join(live_dir, "*", "cert.pem"))):
        domain = os.path.basename(os.path.dirname(cert))
        end = run(["openssl", "x509", "-enddate", "-noout", "-in", cert]).strip()
        expires = days = None
        if end.startswith("notAfter="):
            try:
                t = dt.datetime.strptime(end[9:], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=dt.timezone.utc)
                expires = int(t.timestamp())
                days = int((t - dt.datetime.now(dt.timezone.utc)).total_seconds() // 86400)
            except ValueError:
                pass
        out.append({"domain": domain, "expires": expires, "days": days})
    return out


def top_processes(n=6):
    out = []
    for line in run(["ps", "-eo", "comm=,rss=,pcpu=", "--sort=-rss"]).splitlines()[:n]:
        parts = line.rsplit(None, 2)
        if len(parts) == 3:
            try:
                out.append({"name": parts[0], "rss": int(parts[1]) * 1024, "cpu": float(parts[2])})
            except ValueError:
                pass
    return out


def health(db, state, now, args):
    m = meminfo()
    du = shutil.disk_usage("/")
    with open("/proc/uptime") as f:
        uptime = int(float(f.read().split()[0]))
    with open("/proc/loadavg") as f:
        load = [float(x) for x in f.read().split()[:3]]
    rx = tx = 0
    try:
        with open("/proc/net/dev") as f:
            for line in f.readlines()[2:]:
                name, data = line.split(":", 1)
                if name.strip() != "lo":
                    v = data.split()
                    rx += int(v[0])
                    tx += int(v[8])
    except OSError:
        pass
    osname = ""
    for line in open("/etc/os-release", encoding="utf-8") if os.path.exists("/etc/os-release") else []:
        if line.startswith("PRETTY_NAME="):
            osname = line.split("=", 1)[1].strip().strip('"')
    updates = None
    notifier = "/var/lib/update-notifier/updates-available"
    if os.path.exists(notifier):
        mt = re.search(r"(\d+) (?:updates?|mises? à jour)", open(notifier, encoding="utf-8", errors="replace").read())
        updates = int(mt.group(1)) if mt else 0
    services = []
    for unit, label in SERVICES:
        name, present, active = unit_state(unit)
        services.append({"name": name, "label": label, "present": present, "active": active})
    cpu = cpu_percent(state)
    mem_used = m.get("MemTotal", 0) - m.get("MemAvailable", 0)
    swap_used = m.get("SwapTotal", 0) - m.get("SwapFree", 0)
    snap = {
        "at": now, "cpu": round(cpu, 1), "cpus": os.cpu_count() or 1, "load": load, "uptime": uptime, "os": osname,
        "mem": {"used": mem_used, "total": m.get("MemTotal", 0)}, "swap": {"used": swap_used, "total": m.get("SwapTotal", 0)},
        "disk": {"used": du.used, "total": du.total}, "net": {"rx": rx, "tx": tx},
        "services": services, "certs": cert_list(args.letsencrypt), "top": top_processes(),
        "updates": updates, "reboot": os.path.exists("/var/run/reboot-required"),
    }
    db.execute("INSERT OR REPLACE INTO health VALUES (?,?,?,?,?,?,?,?,?)",
               (now, cpu, mem_used, m.get("MemTotal", 0), swap_used, m.get("SwapTotal", 0), du.used, du.total, load[0]))
    return snap


# ---------------------------------------------------------------- jeux (Docker)
def connections(port):
    """Nombre d'adresses distinctes connectées au port local du jeu (≈ joueurs ; nginx relaie avec X-Real-IP)."""
    out = run(["ss", "-Htn", "state", "established", f"( sport = :{port} )"])
    peers = {line.split()[-1].rsplit(":", 1)[0] for line in out.splitlines() if line.strip()}
    return len(peers)


def docker_state(db, now):
    containers = []
    ps = run(["docker", "ps", "-a", "--filter", "label=com.docker.compose.project=glsc-games", "--format", "{{json .}}"])
    stats = {}
    for line in run(["docker", "stats", "--no-stream", "--format", "{{json .}}"], timeout=30).splitlines():
        try:
            s = json.loads(line)
            stats[s["Name"]] = s
        except (ValueError, KeyError):
            continue
    for line in ps.splitlines():
        try:
            c = json.loads(line)
        except ValueError:
            continue
        labels = dict(kv.split("=", 1) for kv in c.get("Labels", "").split(",") if "=" in kv)
        service = labels.get("com.docker.compose.service", "")
        if service not in GAMES:
            continue
        label, port, domain = GAMES[service]
        s = stats.get(c["Names"], {})
        cpu = mem = None
        try:
            cpu = float(s.get("CPUPerc", "").rstrip("%"))
        except ValueError:
            pass
        mem = parse_size(s.get("MemUsage", "").split("/")[0].strip()) if s else None
        restarts = run(["docker", "inspect", "-f", "{{.RestartCount}}", c["Names"]]).strip()
        conns = connections(port) if c.get("State") == "running" else 0
        containers.append({"name": c["Names"], "service": service, "label": label, "domain": domain, "port": port,
                           "state": c.get("State", "?"), "status": c.get("Status", ""), "image": c.get("Image", ""),
                           "cpu": cpu, "mem": mem, "conns": conns, "restarts": int(restarts) if restarts.isdigit() else 0})
        db.execute("INSERT INTO games VALUES (?,?,?,?,?)", (now, service, conns, cpu, mem))
    containers.sort(key=lambda c: list(GAMES).index(c["service"]))
    return {"at": now, "containers": containers}


def parse_size(s):
    mt = re.match(r"([\d.]+)\s*([KMGT]?i?B)", s)
    if not mt:
        return None
    mult = {"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "TiB": 1024**4}
    return int(float(mt.group(1)) * mult.get(mt.group(2), 1))


# ---------------------------------------------------------------- sécurité
SSH_FAIL = re.compile(r"Failed (?:password|publickey) for (?!invalid user)(\S+) from (\S+)")
SSH_INVALID = re.compile(r"Invalid user (\S*) from (\S+)")
SSH_OK = re.compile(r"Accepted (\S+) for (\S+) from (\S+)")


def ssh_events(db, state, now):
    since = state.get("ssh_since", now - 3600)
    out = run(["journalctl", "-t", "sshd", "-t", "sshd-session", "--since", f"@{since}", "-o", "short-unix", "-q", "--no-pager"], timeout=30)
    accepted = []
    last = since
    for line in out.splitlines():
        try:
            ts = int(float(line.split(" ", 1)[0]))
        except ValueError:
            continue
        last = max(last, ts)
        if mt := SSH_OK.search(line):
            db.execute("INSERT INTO ssh VALUES (?,?,?,?)", (ts, mt.group(3), mt.group(2), "accepted"))
            accepted.append({"ts": ts, "user": mt.group(2), "ip": mt.group(3), "method": mt.group(1)})
        elif mt := SSH_INVALID.search(line):
            db.execute("INSERT INTO ssh VALUES (?,?,?,?)", (ts, mt.group(2), mt.group(1)[:40], "invalid"))
        elif mt := SSH_FAIL.search(line):
            db.execute("INSERT INTO ssh VALUES (?,?,?,?)", (ts, mt.group(2), mt.group(1)[:40], "fail"))
    state["ssh_since"] = last + 1 if out.strip() else max(since, now - 120)
    return accepted


def fail2ban():
    if not shutil.which("fail2ban-client"):
        return None
    jails = re.search(r"Jail list:\s*(.*)", run(["fail2ban-client", "status"]))
    out = []
    for jail in [j.strip() for j in (jails.group(1).split(",") if jails else []) if j.strip()]:
        txt = run(["fail2ban-client", "status", jail])
        banned = re.search(r"Banned IP list:\s*(.*)", txt)
        total = re.search(r"Total banned:\s*(\d+)", txt)
        out.append({"name": jail, "banned": banned.group(1).split() if banned else [], "total": int(total.group(1)) if total else 0})
    return out


# ---------------------------------------------------------------- activité publique pour share.glsc.fr
def github_projects(user, repos, state, now):
    """Langages et derniers commits de chaque dépôt public, pour la page Projets.

    L'API sans jeton est limitée à 60 appels par heure : on ne redemande le détail d'un dépôt
    (2 appels) que lorsque sa date de dernier push a changé. Le reste vient du cache (state).
    """
    cache = state.setdefault("projects", {})
    since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 90 * 86400))
    calls = 0
    for r in repos:
        if r.get("private"):
            continue
        name, c = r["name"], cache.get(r["name"], {})
        if c.get("pushed") != r["pushed"] and calls < 24:  # au pire 26 appels par passage
            langs = http_json(f"https://api.github.com/repos/{user}/{name}/languages")
            commits = http_json(f"https://api.github.com/repos/{user}/{name}/commits?since={since}&per_page=100")
            calls += 2
            total = sum(langs.values()) or 1
            c = {
                "pushed": r["pushed"],
                "languages": [[k, round(v * 100 / total, 1)] for k, v in sorted(langs.items(), key=lambda kv: -kv[1])][:4],
                "dates": [iso_ts(x["commit"]["committer"]["date"]) for x in commits if not x["commit"]["message"].startswith("Merge ")],
                "last": [{"message": x["commit"]["message"].splitlines()[0][:100], "sha": x["sha"][:7], "at": iso_ts(x["commit"]["committer"]["date"])}
                         for x in commits if not x["commit"]["message"].startswith("Merge ")][:3],
            }
            cache[name] = c
    out = []
    for r in repos:
        c = cache.get(r["name"])
        if r.get("private") or not c:
            continue
        out.append({"name": r["name"], "url": r["url"], "stars": r["stars"], "pushed": r["pushed"], "languages": c["languages"],
                    "commits30": sum(1 for d in c["dates"] if d >= now - 30 * 86400),
                    "commits90": len(c["dates"]), "last": c["last"]})
    # fil global : les derniers commits, tous dépôts confondus
    recent = sorted(({**x, "repo": p["name"]} for p in out for x in p["last"]), key=lambda x: -x["at"])[:6]
    return {"at": now, "user": user, "repos": out, "recent": recent}


# ---------------------------------------------------------------- GitHub, sauvegardes, versions
def iso_ts(s):
    return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())


def http_json(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": "glsc-admin", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def github(user):
    repos = http_json(f"https://api.github.com/users/{user}/repos?sort=pushed&per_page=60")
    events = http_json(f"https://api.github.com/users/{user}/events/public?per_page=60")
    commits, feed = [], []

    def ts(s):
        return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())

    for e in events:
        repo = e.get("repo", {}).get("name", "").split("/")[-1]
        at, p, t = ts(e["created_at"]), e.get("payload", {}), e.get("type")
        if t == "PushEvent":
            for c in reversed(p.get("commits", [])):
                if c.get("message", "").startswith("Merge "):
                    continue
                commits.append({"repo": repo, "message": c["message"].splitlines()[0][:120], "sha": c["sha"][:7], "at": at,
                                "url": f"https://github.com/{user}/{repo}/commit/{c['sha']}"})
        elif t == "PullRequestEvent":
            pr = p.get("pull_request", {})
            action = "PR fusionnée" if p.get("action") == "closed" and pr.get("merged") else f"PR {p.get('action', '')}"
            feed.append({"type": action, "repo": repo, "text": f"#{pr.get('number')} {pr.get('title', '')}"[:120], "url": pr.get("html_url"), "at": at})
        elif t == "CreateEvent":
            feed.append({"type": f"{p.get('ref_type', '')} créé", "repo": repo, "text": p.get("ref") or repo, "url": None, "at": at})
        elif t in ("ReleaseEvent", "IssuesEvent", "WatchEvent", "ForkEvent"):
            names = {"ReleaseEvent": "release", "IssuesEvent": "issue", "WatchEvent": "étoile", "ForkEvent": "fork"}
            feed.append({"type": names[t], "repo": repo, "text": (p.get("release") or p.get("issue") or {}).get("name")
                         or (p.get("issue") or {}).get("title") or repo, "url": None, "at": at})
    return {
        "at": int(time.time()),
        # tous les dépôts (page Projets) ; l'admin n'en affiche que les 18 plus récents
        "all": [{"name": r["name"], "description": r.get("description") or "", "url": r["html_url"], "language": r.get("language"),
                 "stars": r.get("stargazers_count", 0), "pushed": ts(r["pushed_at"]), "private": r.get("private", False)}
                for r in repos if not r.get("fork")],
        "commits": commits[:15], "events": feed[:15],
    }


BACKUP_NAME = re.compile(r"^(\d{8})-(\d{6})(?:-(\w+))?$")


def deploys(state, backups_dir, games_src, version_file, now):
    sizes = state.setdefault("backup_sizes", {})
    refresh = now - state.get("sizes_at", 0) > 1800
    backups = []
    for d in sorted(glob.glob(os.path.join(backups_dir, "*")), reverse=True):
        mt = BACKUP_NAME.match(os.path.basename(d))
        if not mt or not os.path.isdir(d):
            continue
        at = int(dt.datetime.strptime(mt.group(1) + mt.group(2), "%Y%m%d%H%M%S").replace(tzinfo=TZ).timestamp())
        name = os.path.basename(d)
        if refresh or name not in sizes:
            out = run(["du", "-sb", d], timeout=60).split()
            sizes[name] = int(out[0]) if out and out[0].isdigit() else None
        backups.append({"name": name, "at": at, "kind": mt.group(3) or "", "size": sizes.get(name)})
    if refresh:
        state["sizes_at"] = now
        state["backup_sizes"] = {b["name"]: b["size"] for b in backups}
    versions = []
    v = load_json(version_file, None)
    if v:
        versions.append({"name": "Sites (portfolio)", "commit": v.get("sha", "?")[:7], "subject": v.get("subject", ""), "at": v.get("at", 0)})
    for repo in sorted(glob.glob(os.path.join(games_src, "*", ".git"))):
        out = run(["git", "-C", os.path.dirname(repo), "log", "-1", "--format=%h|%ct|%s"]).strip()
        if out.count("|") >= 2:
            h, ct, s = out.split("|", 2)
            versions.append({"name": os.path.basename(os.path.dirname(repo)), "commit": h, "subject": s[:100], "at": int(ct)})
    return {"at": now, "backups": backups, "total": sum(b["size"] or 0 for b in backups), "versions": versions}


# ---------------------------------------------------------------- alertes Discord
def app_settings(app_db):
    """Réglages de l'admin (lecture seule) : webhook et alertes activées."""
    try:
        con = sqlite3.connect(f"file:{app_db}?mode=ro", uri=True, timeout=3)
        rows = dict(con.execute("SELECT key, value FROM settings").fetchall())
        con.close()
        return rows
    except sqlite3.Error:
        return {}


def discord(webhook, title, text, color=0xFFD84D, fields=None, url=None):
    if not webhook:
        return False
    embed = {"title": title[:250], "description": text[:3500], "color": color, "timestamp": dt.datetime.now(dt.timezone.utc).isoformat()}
    if fields:  # au plus 25 champs de 1024 caractères (limites Discord)
        embed["fields"] = [{"name": n[:250], "value": v[:1020] or "—", "inline": inline} for n, v, inline in fields[:25]]
    if url:
        embed["url"] = url
    payload = json.dumps({"username": "glsc.fr", "embeds": [embed], "allowed_mentions": {"parse": []}}).encode()
    try:
        req = urllib.request.Request(webhook, data=payload, method="POST", headers={"Content-Type": "application/json", "User-Agent": "glsc-admin"})
        urllib.request.urlopen(req, timeout=8).close()
        return True
    except OSError as e:
        log("discord :", e)
        return False


def alerts(state, settings, now, hl, dk, accepted):
    hook = settings.get("discord_webhook", "")
    on = lambda k: settings.get(f"alert_{k}", "1") == "1"  # noqa: E731
    cool = state.setdefault("cooldown", {})

    def fire(key, every, title, text, color):
        if now - cool.get(key, 0) >= every:
            cool[key] = now
            discord(hook, title, text, color)

    if hl:
        disk = hl["disk"]["used"] / max(1, hl["disk"]["total"])
        if on("disk") and disk > 0.85:
            fire("disk", 6 * 3600, "💾 Disque presque plein", f"{disk:.0%} utilisé sur le serveur.", 0xFF9478)
        mem = hl["mem"]["used"] / max(1, hl["mem"]["total"])
        state["mem_high"] = state.get("mem_high", 0) + 1 if mem > 0.95 else 0
        if on("memory") and state["mem_high"] >= 3:
            fire("memory", 3600, "🧠 Mémoire saturée", f"{mem:.0%} de RAM utilisée depuis 3 min.", 0xFF9478)
        for c in hl["certs"]:
            if on("cert") and c["days"] is not None and c["days"] < 14:
                fire("cert:" + c["domain"], 86400, "🔐 Certificat bientôt expiré", f"{c['domain']} expire dans {c['days']} jours (certbot devrait le renouveler).", 0xFFD84D)
    if dk:
        prev = state.setdefault("containers", {})
        for c in dk["containers"]:
            was = prev.get(c["service"])
            if on("game_down") and was == "running" and c["state"] != "running":
                discord(hook, f"🎮 {c['label']} est arrêté", f"État du conteneur : {c['state']} ({c['status']}).", 0xEF4444)
            if on("game_down") and was not in (None, "running") and c["state"] == "running":
                discord(hook, f"✅ {c['label']} est reparti", "Le conteneur tourne à nouveau.", 0x22C55E)
            prev[c["service"]] = c["state"]
    if on("ssh"):
        for a in accepted:
            discord(hook, "🖥️ Connexion SSH au serveur", f"Utilisateur **{a['user']}** depuis {a['ip']} ({a['method']}).", 0x8FD3FF)


def sync_status_webhook(state, settings, path):
    """status.glsc.fr prévient déjà quand un site tombe : on lui passe le webhook réglé dans l'admin."""
    hook = settings.get("discord_webhook", "") if settings.get("alert_site_down", "1") == "1" else ""
    if not os.path.isdir(os.path.dirname(path)):
        return
    current = open(path, encoding="utf-8").read().strip() if os.path.exists(path) else ""
    ours = state.get("status_hook", "")
    if hook and current != hook and (not current or current == ours):
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            f.write(hook + "\n")
        os.chmod(path + ".tmp", 0o640)
        try:
            shutil.chown(path + ".tmp", "root", "glsc-status")
        except (LookupError, PermissionError):
            pass
        os.replace(path + ".tmp", path)
        state["status_hook"] = hook
    elif not hook and current and current == ours:
        os.remove(path)
        state["status_hook"] = ""


# ---------------------------------------------------------------- publication
def publish_db(work_db, pub_db, gid):
    tmp = pub_db + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    src = sqlite3.connect(work_db)
    dst = sqlite3.connect(tmp)
    src.backup(dst)
    dst.execute("PRAGMA journal_mode=DELETE")
    dst.close()
    src.close()
    os.chmod(tmp, 0o640)
    if gid is not None:
        try:
            os.chown(tmp, 0, gid)
        except PermissionError:
            pass
    os.replace(tmp, pub_db)

# ---------------------------------------------------------------- classements des jeux
# Recherchés dans le pseudo entier (même collés ou écrits en l33t) ; les mots courts ou ambigus
# (« Monique », « computer », « Montenegro »…) ne sont refusés que seuls.
INSULTS = ("connard", "connasse", "salope", "putain", "encule", "batard", "bougnoul", "nazi", "hitler", "fuck", "bitch",
           "nigger", "nigga", "whore", "porno", "couille", "merde")
INSULT_WORDS = {"pd", "tg", "fdp", "ntm", "con", "conne", "pute", "putes", "nique", "niquer", "negre", "negro", "pede", "cunt",
                "shit", "chatte", "bite", "sex", "sexe", "porn", "penis", "ss"}
DEFAULT_NAMES = re.compile(r"^(joueur|joueuse|player|invite|guest|anonyme|anonymous|moi|test|bot|hote|host|toto)\s*\d*$")
LEET = str.maketrans("013457@$", "oieastas")


def name_key(name):
    """Clé d'un pseudo : sans accents ni majuscules, espaces réduits (« Gabin » = « gabin » = « GABIN »)."""
    import unicodedata
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return " ".join(plain.casefold().split()) or name.casefold().strip()


def name_ok(key):
    """False pour un pseudo par défaut ou injurieux : il n'apparaît jamais dans le classement public."""
    if DEFAULT_NAMES.match(key):
        return False
    squashed = re.sub(r"[^a-z]", "", key.translate(LEET))
    words = set(re.findall(r"[a-z]+", key.translate(LEET)))
    return not (any(w in squashed for w in INSULTS) or words & INSULT_WORDS)


def ingest_results(db, state, data_dir, now):
    """Lit les nouvelles lignes de chaque results.jsonl (écrits par les jeux) ; seuls les humains sont gardés."""
    offsets = state.setdefault("results", {})
    added = 0
    for game in GAMES:
        path = os.path.join(data_dir, game, "results.jsonl")
        try:
            st = os.stat(path)
        except OSError:
            continue
        pos = offsets.get(game, {})
        start = pos.get("off", 0) if pos.get("ino") == st.st_ino and st.st_size >= pos.get("off", 0) else 0
        with open(path, "rb") as f:
            f.seek(start)
            chunk = f.read(4 * 1024 * 1024)
        end = chunk.rfind(b"\n") + 1  # une ligne en cours d'écriture attend le prochain passage
        offset = start
        for raw in chunk[:end].splitlines(keepends=True):
            line_at, offset = offset, offset + len(raw)
            try:
                r = json.loads(raw)
                t, players = int(r["t"]), r["players"]
                if r.get("game") != game or not isinstance(players, list) or len(players) > 16 or not now - 400 * 86400 < t <= now + 300:
                    continue
            except (ValueError, KeyError, TypeError):
                continue
            match = f"{game}:{st.st_ino}:{line_at}"
            mode = str(r.get("mode", ""))[:20]
            for p in players:
                if not isinstance(p, dict) or p.get("bot") is not False or not isinstance(p.get("name"), str):
                    continue
                name = " ".join(p["name"].split())[:24]
                if not name:
                    continue
                num = lambda k: int(p[k]) if isinstance(p.get(k), (int, float)) else None  # noqa: E731
                pid = p.get("pid") if isinstance(p.get("pid"), str) and re.fullmatch(r"[0-9a-f]{16}", p["pid"]) else None
                db.execute("INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                           (t, game, match, mode, name, name_key(name), num("rank") or 0, 1 if p.get("won") is True else 0,
                            str(p["role"])[:20] if isinstance(p.get("role"), str) else None, num("kills"), num("deaths"), num("assists"), pid))
                added += 1
        offsets[game] = {"ino": st.st_ino, "off": start + end}
    return added


# Succès : (id, jeu ou "all", emoji, nom, description, condition sur l'état du joueur après chaque partie)
ACHIEVEMENTS = [
    ("uno-win1", "uno", "🎯", "Première victoire", "Gagner une partie de +4", lambda s: s["wins"] >= 1),
    ("uno-win10", "uno", "🏆", "Dix victoires", "10 parties gagnées", lambda s: s["wins"] >= 10),
    ("uno-win50", "uno", "👑", "Roi du +4", "50 parties gagnées", lambda s: s["wins"] >= 50),
    ("uno-streak3", "uno", "🔥", "Série de 3", "3 victoires d'affilée", lambda s: s["best_streak"] >= 3),
    ("uno-played25", "uno", "🃏", "Habitué", "25 parties jouées", lambda s: s["played"] >= 25),
    ("pres-first", "president", "👑", "Président !", "Finir premier d'une manche", lambda s: s["president"] >= 1),
    ("pres-streak3", "president", "🔥", "Règne de 3", "Président 3 manches d'affilée", lambda s: s["pres_streak"] >= 3),
    ("pres-10", "president", "🏛️", "Dynastie", "10 fois président", lambda s: s["president"] >= 10),
    ("pres-trouduc3", "president", "🧻", "Abonné au trou du cul", "Finir dernier 3 fois (c'est un titre)", lambda s: s["trouduc"] >= 3),
    ("pres-played25", "president", "🎴", "Habitué", "25 manches jouées", lambda s: s["played"] >= 25),
    ("bac-win1", "petitbac", "🎯", "Premier Bac", "Gagner une partie de Petit Bac", lambda s: s["wins"] >= 1),
    ("bac-win10", "petitbac", "🏆", "Maître du Bac", "10 parties gagnées", lambda s: s["wins"] >= 10),
    ("bac-streak3", "petitbac", "🔥", "Série de 3", "3 victoires d'affilée", lambda s: s["best_streak"] >= 3),
    ("bac-played25", "petitbac", "✏️", "Habitué", "25 parties jouées", lambda s: s["played"] >= 25),
    ("vortex-1", "vortex", "🎯", "Première élimination", "Éliminer un adversaire", lambda s: s["kills"] >= 1),
    ("vortex-round10", "vortex", "🔫", "Manche parfaite", "10 éliminations dans une seule manche", lambda s: s["best_kills"] >= 10),
    ("vortex-50", "vortex", "💥", "50 éliminations", "50 éliminations au total", lambda s: s["kills"] >= 50),
    ("vortex-250", "vortex", "☠️", "Terreur du vortex", "250 éliminations au total", lambda s: s["kills"] >= 250),
    ("vortex-played25", "vortex", "🌀", "Habitué", "25 manches jouées", lambda s: s["played"] >= 25),
    ("daily-1", "all", "📅", "Défi relevé", "Réussir un défi du jour", lambda s: False),  # débloqué par compute_extras
    ("daily-7", "all", "🔥", "Assidu", "7 défis du jour d'affilée", lambda s: False),
    ("all-3", "all", "🎮", "Touche-à-tout", "Jouer à trois jeux différents avec le même profil ou pseudo", lambda s: s["games"] >= 3),
]


def load_profiles(games_data):
    """Profils des joueurs (écrits par le service « profiles ») : ({pid: {name, key, since}}, pseudos et identifiants supprimés).
    Fichier absent ou illisible : aucun profil, donc tout le monde est compté comme avant, par pseudo."""
    data = load_json(os.path.join(games_data, "profiles", "profiles.json"), {})
    live, gone_keys, gone_pids = {}, set(), set()
    for pid, p in (data.get("profiles") or {}).items():
        if not isinstance(p, dict):
            continue
        if p.get("deleted"):
            gone_pids.add(pid)
            if p.get("key"):
                gone_keys.add(p["key"])
        elif p.get("name") and p.get("key"):
            live[pid] = {"name": p["name"], "key": p["key"], "since": int(p.get("createdAt", 0) // 1000)}
    return live, gone_keys, gone_pids


def identities(profiles):
    live, gone_keys, gone_pids = profiles
    return live, {p["key"]: pid for pid, p in live.items()}, gone_pids, gone_keys


def ident_of(pid, key, live, by_key, deleted, gone_keys):
    """Qui est derrière une ligne de résultat : « p:<pid> » pour un profil (y compris l'historique joué sous son pseudo
    avant de le réserver), sinon la clé du pseudo comme avant. Les parties d'un profil supprimé disparaissent."""
    if pid in deleted:
        return None
    if pid in live:
        return "p:" + pid
    if key in by_key:
        return "p:" + by_key[key]
    return None if key in gone_keys else key


def unlock_achievements(db, ids):
    """Rejoue l'historique des parties dans l'ordre : {identité: {id du succès: date de déblocage}} et dernier pseudo vu."""
    live, by_key, deleted, gone_keys = ids
    states, unlocked, names = {}, {}, {}
    for ts, game, key, name, won, role, kills, pid in db.execute("SELECT ts, game, key, name, won, role, kills, pid FROM results ORDER BY ts, rowid"):
        who = ident_of(pid, key, live, by_key, deleted, gone_keys)
        if who is None:
            continue
        st = states.setdefault((who, game), {"played": 0, "wins": 0, "streak": 0, "best_streak": 0, "president": 0, "pres_streak": 0, "pres_run": 0,
                                              "trouduc": 0, "kills": 0, "best_kills": 0, "games": 0})
        names[who] = live[who[2:]]["name"] if who.startswith("p:") and who[2:] in live else name
        st["played"] += 1
        st["wins"] += won
        st["streak"] = st["streak"] + 1 if won else 0
        st["best_streak"] = max(st["best_streak"], st["streak"])
        if role == "president":
            st["president"] += 1
            st["pres_run"] += 1
            st["pres_streak"] = max(st["pres_streak"], st["pres_run"])
        else:
            st["pres_run"] = 0
        st["trouduc"] += 1 if role == "trouduc" else 0
        st["kills"] += kills or 0
        st["best_kills"] = max(st["best_kills"], kills or 0)
        mine = unlocked.setdefault(who, {})
        st["games"] = sum(1 for g in GAMES if (who, g) in states)
        for aid, agame, _, _, _, cond in ACHIEVEMENTS:
            if aid not in mine and (agame == game or agame == "all") and cond(st):
                mine[aid] = ts
    return unlocked, names


def leaderboards(db, now, hidden, profiles=None, extra_unlocks=None):
    """Classements par jeu, sur 7 jours et depuis toujours. Version publique (filtrée) et version admin (tout, avec raisons).
    Un profil regroupe toutes ses parties (renommer ne perd rien) ; sans profil, le pseudo fait foi comme avant."""
    ids = identities(profiles or ({}, set(), set()))
    live, by_key, deleted, gone_keys = ids
    week = now - 7 * 86400
    public, admin = {"at": now, "games": {}}, {"at": now, "games": {}}
    unlocked, last_names = unlock_achievements(db, ids)
    for who, got in (extra_unlocks or {}).items():
        if who in last_names or who in unlocked:
            unlocked.setdefault(who, {}).update(got)
    key_of = lambda who: live[who[2:]]["key"] if who.startswith("p:") else who  # noqa: E731
    shown = {w for w in unlocked if key_of(w) not in hidden and name_ok(key_of(w))}
    for game in GAMES:
        g_pub, g_adm = {}, {}
        for period, since in (("week", week), ("month", month_start(now)), ("all", 0)):
            agg, matches, players = {}, set(), set()
            for ts, match, key, name, won, role, kills, deaths, assists, pid in db.execute(
                    "SELECT ts, match, key, name, won, role, kills, deaths, assists, pid FROM results WHERE game = ? AND ts >= ? ORDER BY ts",
                    (game, since)):
                who = ident_of(pid, key, live, by_key, deleted, gone_keys)
                if who is None:
                    continue
                matches.add(match)
                players.add(who)
                a = agg.setdefault(who, {"name": name, "last": 0, "played": 0, "wins": 0, "kills": 0, "deaths": 0, "assists": 0, "pres": 0, "trou": 0})
                a.update(name=name, last=ts)
                a["played"] += 1
                a["wins"] += won
                a["kills"] += kills or 0
                a["deaths"] += deaths or 0
                a["assists"] += assists or 0
                a["pres"] += 1 if role == "president" else 0
                a["trou"] += 1 if role == "trouduc" else 0
            if game == "vortex":
                order = lambda kv: (-kv[1]["kills"], kv[1]["deaths"], -kv[1]["last"])  # noqa: E731
            else:
                order = lambda kv: (-kv[1]["wins"], kv[1]["played"], -kv[1]["last"])  # noqa: E731
            board, review = [], []
            for who, a in sorted(agg.items(), key=order)[:150]:
                name = live[who[2:]]["name"] if who.startswith("p:") else a["name"]
                key = key_of(who)
                entry = {"name": name, "played": a["played"], "wins": a["wins"]}
                if game == "vortex":
                    entry.update(kills=a["kills"], deaths=a["deaths"], assists=a["assists"])
                if game == "president":
                    entry.update(president=a["pres"], trouduc=a["trou"])
                why = "masqué" if key in hidden else None if name_ok(key) else "filtré"
                review.append({**entry, "key": key, "last": a["last"], "hidden": why, "profil": who.startswith("p:")})
                if not why and len(board) < 10 and (entry["wins"] or entry.get("kills")):
                    entry["badges"] = [x[0] for x in ACHIEVEMENTS if x[1] in (game, "all") and x[0] in unlocked.get(who, {})]
                    if who.startswith("p:"):
                        entry["profil"] = True
                    board.append(entry)
            g_pub[period] = {"matches": len(matches), "players": len(players), "top": board}
            g_adm[period] = {"matches": len(matches), "players": len(players), "names": review[:100]}
            if game == "president":  # le titre que personne ne veut
                worst = sorted((e for e in review if not e["hidden"] and e["trouduc"]), key=lambda e: (-e["trouduc"], e["played"]))
                g_pub[period]["trouduc"] = {k: worst[0][k] for k in ("name", "trouduc", "played")} if worst else None
        public["games"][game], admin["games"][game] = g_pub, g_adm
    public["achievements"] = []
    for aid, agame, emoji, label, desc, _ in ACHIEVEMENTS:
        who = sorted(((unlocked[k][aid], last_names[k]) for k in shown if aid in unlocked[k]), reverse=True)
        public["achievements"].append({"id": aid, "game": agame, "emoji": emoji, "name": label, "desc": desc, "count": len(who),
                                       "recent": [{"name": n, "at": t} for t, n in who[:3]]})
    return public, admin


def publish_cards(fiches, root, state):
    """Cartes de profil partageables (glsc_cards.py, nécessite Pillow : sans lui, l'étape est ignorée)."""
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        import glsc_cards
    except ImportError as e:
        if not state.get("cards_missing"):
            log("cartes de profil ignorées :", e)
        state["cards_missing"] = True
        return 0
    state.pop("cards_missing", None)
    return glsc_cards.publish(fiches["players"], root, os.path.join(here, "cards", "fonts"), state.setdefault("cards", {}))


def players_page(db, now, hidden, profiles, extras=None):
    """Fiches publiques des profils (players.json) : statistiques par jeu et succès, sans rien de privé."""
    ids = identities(profiles)
    live, by_key, deleted, gone_keys = ids
    unlocked, _ = unlock_achievements(db, ids)
    extras = extras or {}
    for who, got in extras.get("unlocks", {}).items():
        unlocked.setdefault(who, {}).update(got)
    out = {}
    for pid, p in live.items():
        if p["key"] in hidden or not name_ok(p["key"]):
            continue
        out[pid] = {"name": p["name"], "since": p["since"], "games": {}, "achievements": []}
    for game, key, won, role, kills, deaths, pid, ts in db.execute("SELECT game, key, won, role, kills, deaths, pid, ts FROM results ORDER BY ts"):
        who = ident_of(pid, key, live, by_key, deleted, gone_keys)
        if not who or not who.startswith("p:") or who[2:] not in out:
            continue
        g = out[who[2:]]["games"].setdefault(game, {"played": 0, "wins": 0, "kills": 0, "deaths": 0, "president": 0, "trouduc": 0, "last": 0})
        g["played"] += 1
        g["wins"] += won
        g["kills"] += kills or 0
        g["deaths"] += deaths or 0
        g["president"] += 1 if role == "president" else 0
        g["trouduc"] += 1 if role == "trouduc" else 0
        g["last"] = ts
    for pid, entry in out.items():
        entry["achievements"] = sorted(({"id": a, "at": t} for a, t in unlocked.get("p:" + pid, {}).items()), key=lambda x: x["at"])
        entry["titles"] = extras.get("titles", {}).get(pid, [])
        entry["daily"] = extras.get("daily", {}).get(pid, {"streak": 0, "best": 0, "done": False, "progress": 0})
        entry["history"] = extras.get("history", {}).get(pid, [])
        entry["rivals"] = extras.get("rivals", {}).get(pid, {})
        for game, st in extras.get("month_stats", {}).get(pid, {}).items():
            if game in entry["games"]:
                entry["games"][game]["month"] = st
    return {"at": now, "players": out}



# ---------------------------------------------------------------- saisons, historique, défis du jour
def paris_day(ts):
    return dt.datetime.fromtimestamp(ts, TZ).date()


def day_start(day):
    return int(dt.datetime(day.year, day.month, day.day, tzinfo=TZ).timestamp())


def month_start(ts):
    d = paris_day(ts)
    return day_start(d.replace(day=1))


CHALLENGES = [  # (jeu ou « any », genre, objectif, texte) ; un défi par jour, tiré selon la date (le même pour tout le monde)
    ("uno", "win", 1, "Gagne une partie de +4"),
    ("president", "play", 3, "Joue 3 manches du Président"),
    ("petitbac", "play", 1, "Joue une partie de Petit Bac"),
    ("any", "play", 3, "Joue 3 parties, tous jeux confondus"),
    ("vortex", "kills", 5, "Fais 5 éliminations à Vortex"),
    ("uno", "play", 2, "Joue 2 parties de +4"),
    ("petitbac", "win", 1, "Gagne une partie de Petit Bac"),
    ("president", "president", 1, "Finis président une fois"),
]


def challenge_for(day):
    game, kind, goal, text = CHALLENGES[day.toordinal() % len(CHALLENGES)]
    return {"game": game, "kind": kind, "goal": goal, "text": text}


def challenge_progress(rows, ch):
    """rows : (jeu, gagné, rôle, éliminations) des parties du jour."""
    mine = [r for r in rows if ch["game"] == "any" or r[0] == ch["game"]]
    if ch["kind"] == "win":
        return sum(r[1] for r in mine)
    if ch["kind"] == "kills":
        return sum(r[3] for r in mine)
    if ch["kind"] == "president":
        return sum(1 for r in mine if r[2] == "president")
    return len(mine)


def compute_extras(db, now, hidden, profiles):
    """Tout ce qui se calcule en rejouant les résultats : champions des mois passés, titres, historique des parties,
    défis du jour (série de jours) et succès associés, statistiques du mois en cours par profil."""
    ids = identities(profiles)
    live, by_key, deleted, gone_keys = ids
    today = paris_day(now)
    month_now = today.strftime("%Y-%m")
    per_month, shown_names, days, matches = {}, {}, {}, {}
    for ts, game, match, key, name, rank, won, role, kills, pid in db.execute(
            "SELECT ts, game, match, key, name, rank, won, role, kills, pid FROM results ORDER BY ts"):
        who = ident_of(pid, key, live, by_key, deleted, gone_keys)
        if who is None:
            continue
        profile = who.startswith("p:") and who[2:] in live
        shown_names[who] = live[who[2:]]["name"] if profile else name
        day = paris_day(ts)
        st = per_month.setdefault((day.strftime("%Y-%m"), game, who), {"played": 0, "wins": 0, "kills": 0})
        st["played"] += 1
        st["wins"] += won
        st["kills"] += kills or 0
        if profile:
            days.setdefault(who, {}).setdefault(day, []).append((game, won, role, kills or 0))
        m = matches.setdefault(match, {"game": game, "t": ts, "players": []})
        m["players"].append((who, rank, won))

    def visible(who):
        k = live[who[2:]]["key"] if who.startswith("p:") else who
        return k not in hidden and name_ok(k)

    # champions des mois écoulés (au moins 3 parties et une victoire / une élimination)
    champions, titles = [], {}
    months = sorted({m for (m, _, _) in per_month if m < month_now}, reverse=True)[:18]
    for month in months:
        for game in GAMES:
            rows = [(who, st) for (m, g, who), st in per_month.items() if m == month and g == game and visible(who)
                    and st["played"] >= 3 and (st["kills"] if game == "vortex" else st["wins"]) >= 1]
            if not rows:
                continue
            key = (lambda r: (-r[1]["kills"], r[1]["played"])) if game == "vortex" else (lambda r: (-r[1]["wins"], r[1]["played"]))
            who, st = sorted(rows, key=key)[0]
            champions.append({"month": month, "game": game, "name": shown_names[who], "wins": st["wins"], "kills": st["kills"],
                              "played": st["played"], "profil": who.startswith("p:")})
            if who.startswith("p:"):
                titles.setdefault(who[2:], []).append({"game": game, "month": month})

    # statistiques du mois en cours, par profil
    month_stats = {}
    for (m, game, who), st in per_month.items():
        if m == month_now and who.startswith("p:") and who[2:] in live:
            month_stats.setdefault(who[2:], {})[game] = st

    # historique : 20 dernières parties de chaque profil
    history = {}
    for m in sorted(matches.values(), key=lambda x: x["t"]):
        pids = [w[2:] for (w, _, _) in m["players"] if w.startswith("p:") and w[2:] in live]
        for who, rank, won in m["players"]:
            if not (who.startswith("p:") and who[2:] in live):
                continue
            others = [shown_names[w] for (w, _, _) in m["players"] if w != who and w.startswith("p:") and w[2:] in live and visible(w)]
            history.setdefault(who[2:], []).append({"game": m["game"], "t": m["t"], "rank": rank, "won": bool(won),
                                                    "n": len(m["players"]), "with": others[:5]})
    history = {pid: rows[-20:][::-1] for pid, rows in history.items()}

    # rivalités : sur les parties jouées ensemble entre profils visibles, qui bat qui (au moins 3 duels)
    duels = {}
    for m in matches.values():
        ps = [(w[2:], r, won) for (w, r, won) in m["players"] if w.startswith("p:") and w[2:] in live and visible(w)]
        for i, (a, ra, wa) in enumerate(ps):
            for b, rb, wb in ps[i + 1:]:
                if a == b:
                    continue
                if ra > 0 and rb > 0 and ra != rb:
                    a_wins = ra < rb
                elif wa != wb:
                    a_wins = bool(wa)
                else:
                    continue
                for x, y, x_wins in ((a, b, a_wins), (b, a, not a_wins)):
                    d = duels.setdefault(x, {}).setdefault(y, [0, 0])
                    d[0 if x_wins else 1] += 1
    rivals = {}
    for pid, vs in duels.items():
        out = {}
        nemesis = sorted(((o, w, l) for o, (w, l) in vs.items() if w + l >= 3 and l > w), key=lambda r: (r[1] - r[2], -(r[1] + r[2])))
        victim = sorted(((o, w, l) for o, (w, l) in vs.items() if w + l >= 3 and w > l), key=lambda r: (-(r[1] - r[2]), -(r[1] + r[2])))
        for label, rows in (("nemesis", nemesis), ("victim", victim)):
            if rows:
                o, w, l = rows[0]
                out[label] = {"name": live[o]["name"], "wins": w, "losses": l}
        if out:
            rivals[pid] = out

    # défis du jour
    ch_today = challenge_for(today)
    daily, unlocks = {}, {}
    for who, per_day in days.items():
        done = sorted(d for d, rows in per_day.items() if challenge_progress(rows, challenge_for(d)) >= challenge_for(d)["goal"])
        done_set = set(done)
        cursor = today if today in done_set else today - dt.timedelta(days=1)
        streak = 0
        while cursor in done_set:
            streak += 1
            cursor -= dt.timedelta(days=1)
        best = run = 0
        got7 = None
        previous = None
        for d in done:
            run = run + 1 if previous is not None and (d - previous).days == 1 else 1
            if run >= 7 and got7 is None:
                got7 = d
            best = max(best, run)
            previous = d
        daily[who[2:]] = {"streak": streak, "best": best, "done": today in done_set,
                          "progress": challenge_progress(per_day.get(today, []), ch_today)}
        got = {}
        if done:
            got["daily-1"] = day_start(done[0] + dt.timedelta(days=1))
        if got7:
            got["daily-7"] = day_start(got7 + dt.timedelta(days=1))
        if got:
            unlocks[who] = got
    return {"challenge": {**ch_today, "date": today.isoformat()}, "champions": champions, "titles": titles,
            "month_stats": month_stats, "history": history, "rivals": rivals, "daily": daily, "unlocks": unlocks}

# ---------------------------------------------------------------- tableau de bord des joueurs (admin)
def player_stats(db, now, hidden, profiles, pub_dir):
    """Qui joue, quand et à quoi : nouveaux et habitués, parties par jour, heures de pointe, jeux, meilleurs joueurs, signalements.
    Un « joueur » est un profil, ou à défaut un pseudo (comme dans les classements)."""
    live, by_key, deleted, gone_keys = identities(profiles)
    today = paris_day(now)
    days30 = [today - dt.timedelta(days=i) for i in range(29, -1, -1)]
    first, played_days, names = {}, {}, {}
    per_day = {d: {"matches": set(), "players": set()} for d in days30}
    hours, games_30, games_all, hour_seen = [0] * 24, {}, {}, set()
    top = {}
    share_profile = share_total = 0
    since30 = now - 30 * 86400
    for ts, game, match, key, name, won, pid in db.execute("SELECT ts, game, match, key, name, won, pid FROM results ORDER BY ts"):
        who = ident_of(pid, key, live, by_key, deleted, gone_keys)
        if who is None:
            continue
        profile = who.startswith("p:") and who[2:] in live
        names[who] = live[who[2:]]["name"] if profile else name
        day = paris_day(ts)
        first.setdefault(who, day)
        played_days.setdefault(who, set()).add(day)
        ga = games_all.setdefault(game, {"matches": set(), "players": set()})
        ga["matches"].add(match)
        if ts >= since30:
            g = games_30.setdefault(game, {"matches": set(), "players": set(), "rows": 0})
            g["matches"].add(match)
            g["players"].add(who)
            g["rows"] += 1
            if day in per_day:
                per_day[day]["matches"].add(match)
                per_day[day]["players"].add(who)
            if match not in hour_seen:  # heures de pointe : une fois par partie
                hour_seen.add(match)
                hours[dt.datetime.fromtimestamp(ts, TZ).hour] += 1
            t = top.setdefault(who, {"matches": 0, "wins": 0})
            t["matches"] += 1
            t["wins"] += won
            share_total += 1
            share_profile += 1 if profile else 0
    everyone = set(first)
    active7 = {w for w, ds in played_days.items() if any((today - d).days < 7 for d in ds)}
    active30 = {w for w, ds in played_days.items() if any((today - d).days < 30 for d in ds)}
    new7 = {w for w in active7 if (today - first[w]).days < 7}
    # fidélité : parmi les joueurs apparus il y a 8 à 30 jours, ceux qui ont rejoué un autre jour que leur premier
    cohort = [w for w in everyone if 8 <= (today - first[w]).days <= 30]
    back = [w for w in cohort if len(played_days[w]) > 1]
    reports = load_json(os.path.join(pub_dir, "reports.json"), {}).get("reports", [])
    labels = {g: v[0] for g, v in GAMES.items()}
    return {
        "at": now,
        "totals": {"players": len(everyone), "profiles": len(live), "active7": len(active7), "active30": len(active30),
                   "new7": len(new7), "returning7": len(active7) - len(new7),
                   "profile_share30": round(100 * share_profile / share_total) if share_total else 0,
                   "reports7": sum(1 for r in reports if (r.get("t") or 0) >= now - 7 * 86400)},
        "retention": {"cohort": len(cohort), "back": len(back), "pct": round(100 * len(back) / len(cohort)) if cohort else None},
        "daily": [{"day": d.isoformat(), "matches": len(v["matches"]), "players": len(v["players"])} for d, v in per_day.items()],
        "hours": hours,
        "games": sorted(({"game": g, "label": labels.get(g, g), "matches30": len(v["matches"]), "players30": len(v["players"]),
                          "avg_players": round(v["rows"] / max(1, len(v["matches"])), 1), "matches_all": len(games_all.get(g, {"matches": ()})["matches"])}
                         for g, v in games_30.items()), key=lambda x: -x["matches30"]),
        "top": [{"name": names[w], "matches": t["matches"], "wins": t["wins"], "profil": w.startswith("p:"),
                 "hidden": (live[w[2:]]["key"] if w.startswith("p:") else w) in hidden}
                for w, t in sorted(top.items(), key=lambda kv: (-kv[1]["matches"], -kv[1]["wins"]))[:10]],
        "reports": reports[:15],
    }


# ---------------------------------------------------------------- journal des nouveautés (PR fusionnées → page + flux Atom)
CHANGELOG_REPOS = {"portfolio": "Site", "plus4": "+4", "president": "Le Président", "petitbac": "Petit Bac", "vortex-fps": "Vortex"}


def changelog_entries(user):
    """Pull requests fusionnées des dépôts suivis, les plus récentes d'abord. Un dépôt injoignable est simplement ignoré."""
    out = []
    for repo, label in CHANGELOG_REPOS.items():
        try:
            prs = http_json(f"https://api.github.com/repos/{user}/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=40")
        except (OSError, ValueError):
            continue
        for pr in prs:
            if not pr.get("merged_at"):
                continue
            title = " ".join(str(pr.get("title", "")).split())[:140]
            if not title or title.lower().startswith("merge "):
                continue
            out.append({"repo": repo, "label": label, "number": pr["number"], "title": title, "url": pr["html_url"], "at": iso_ts(pr["merged_at"])})
    return sorted(out, key=lambda e: -e["at"])[:80]


def xml_escape(text):
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def changelog_atom(entries, now):
    iso = lambda t: dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    items = "".join(
        f"<entry><id>tag:glsc.fr,2026:{xml_escape(e['repo'])}/{e['number']}</id><title>{xml_escape('[' + e['label'] + '] ' + e['title'])}</title>"
        f"<link href=\"{xml_escape(e['url'])}\"/><updated>{iso(e['at'])}</updated></entry>"
        for e in entries[:40])
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>https://games.glsc.fr/nouveautes/</id>'
            '<title>Nouveautés de glsc.fr</title><subtitle>Ce qui change sur le site et les jeux</subtitle>'
            '<link href="https://games.glsc.fr/nouveautes/"/><link rel="self" href="https://games.glsc.fr/nouveautes.xml"/>'
            f"<updated>{iso(entries[0]['at'] if entries else now)}</updated><author><name>Gabin Lescoat</name></author>{items}</feed>\n")


# ---------------------------------------------------------------- signalements de bugs (bouton « Un bug ? » des jeux)
REPORT_GAMES = {"plus4": "+4", "president": "Le Président", "petitbac": "Petit Bac", "vortex": "Vortex", "site": "Site"}


def short_ua(ua):
    """« Chrome · Android » : de quoi reproduire un bug, sans empreinte détaillée."""
    ua = ua or ""
    browser = next((n for k, n in (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari")) if k in ua), "navigateur ?")
    system = next((n for k, n in (("Android", "Android"), ("iPhone", "iPhone"), ("iPad", "iPad"), ("Windows", "Windows"), ("Mac OS", "macOS"), ("Linux", "Linux")) if k in ua), "")
    return browser + (f" · {system}" if system else "")


def process_reports(args, state, settings, now):
    """Nouveaux signalements (reports.jsonl, écrit par le service de profils) → Discord (au plus 5 par passage) + pub/reports.json."""
    path = os.path.join(args.games_data, "profiles", "reports.jsonl")
    try:
        st = os.stat(path)
    except OSError:
        return 0
    pos = state.get("reports", {})
    start = pos.get("off", 0) if pos.get("ino") == st.st_ino and st.st_size >= pos.get("off", 0) else 0
    with open(path, "rb") as f:
        f.seek(start)
        chunk = f.read(512 * 1024)
    end = chunk.rfind(b"\n") + 1
    fresh = []
    for raw in chunk[:end].splitlines():
        try:
            r = json.loads(raw)
            if isinstance(r, dict) and isinstance(r.get("message"), str):
                fresh.append(r)
        except ValueError:
            continue
    state["reports"] = {"ino": st.st_ino, "off": start + end}
    if not fresh:
        return 0
    recent = load_json(os.path.join(args.pub_dir, "reports.json"), {}).get("reports", [])
    keep = [{k: r.get(k) for k in ("t", "game", "message", "room", "phase", "page", "name", "ua")} for r in fresh]
    write_json(os.path.join(args.pub_dir, "reports.json"), {"at": now, "reports": (keep[::-1] + recent)[:60]}, www_gid())
    if settings.get("alert_report", "1") == "1":
        hook = settings.get("discord_webhook", "")
        for r in fresh[:5]:
            text = str(r.get("message", "")).replace("```", "ʼʼʼ")[:900]
            fields = [("Joueur", str(r.get("name") or "invité"), True), ("Navigateur", short_ua(r.get("ua")), True)]
            if r.get("room"):
                fields.append(("Salon", f"`{r['room']}`" + (f" ({r['phase']})" if r.get("phase") else ""), True))
            discord(hook, f"🐞 Bug signalé · {REPORT_GAMES.get(r.get('game'), 'Jeu ?')}", f"```\n{text}\n```", 0xF59E0B, fields)
        if len(fresh) > 5:
            discord(hook, "🐞 Autres signalements", f"{len(fresh) - 5} signalement(s) de plus : voir l'admin.", 0xF59E0B)
    return len(fresh)


# ---------------------------------------------------------------- récap Discord du lundi
SITE_NAMES = {"glsc.fr": "Hub", "cv.glsc.fr": "CV", "share.glsc.fr": "Projets", "old.glsc.fr": "Archives", "games.glsc.fr": "Salle de jeux",
              "status.glsc.fr": "Statut", "plus4.glsc.fr": "+4", "uno.glsc.fr": "+4", "president.glsc.fr": "Président", "petitbac.glsc.fr": "Petit Bac", "vortex.glsc.fr": "Vortex"}
CV_EVENTS = {"print": "impressions", "email": "clics e-mail", "email_copy": "e-mails copiés", "phone": "clics téléphone",
             "linkedin": "clics LinkedIn", "github": "clics GitHub", "site": "clics site"}


def source_of(ref):
    """Même regroupement que l'admin (Trafic) : d'où viennent les visiteurs."""
    host = (urllib.parse.urlsplit(ref).hostname or "") if ref not in ("", "-") else ""
    host = re.sub(r"^(www|m|l|lm)\.", "", host)
    for key, name in (("linkedin", "LinkedIn"), ("lnkd.in", "LinkedIn"), ("google", "Google"), ("bing", "Bing"), ("duckduckgo", "DuckDuckGo"),
                      ("github", "GitHub"), ("indeed", "Indeed"), ("welcometothejungle", "Welcome to the Jungle"), ("discord", "Discord")):
        if key in host:
            return name
    return "Direct" if not host else None if host.endswith("glsc.fr") else host


def week_bounds(now):
    """Semaine écoulée : du lundi 0 h au lundi suivant 0 h (heure de Paris)."""
    today = dt.datetime.fromtimestamp(now, TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    end = today - dt.timedelta(days=today.weekday())
    start = end - dt.timedelta(days=7)
    return int(start.timestamp()), int(end.timestamp())


def trend(cur, prev):
    if not prev:
        return " (nouveau)" if cur else ""
    p = round((cur - prev) * 100 / prev)
    return f" ({'+' if p >= 0 else ''}{p} %)" if p else " (=)"


def fr(n):
    return f"{n:,}".replace(",", " ")


def weekly_recap(db, state, start, end, pub_dir, status_file):
    """Titre, texte et champs du récap entre start et end (comparé à la période d'avant, de même durée)."""
    prev = (2 * start - end, start)
    one = lambda sql, args=(): db.execute(sql, args).fetchone()[0] or 0  # noqa: E731
    fields = []

    # Visites
    views = one("SELECT COUNT(*) FROM requests WHERE page = 1 AND ts >= ? AND ts < ?", (start, end))
    views_prev = one("SELECT COUNT(*) FROM requests WHERE page = 1 AND ts >= ? AND ts < ?", prev)
    visitors = one("SELECT COUNT(DISTINCT ip || ua) FROM requests WHERE page = 1 AND ts >= ? AND ts < ?", (start, end))
    sites = db.execute("SELECT host, COUNT(*) n FROM requests WHERE page = 1 AND ts >= ? AND ts < ? GROUP BY host ORDER BY n DESC LIMIT 4",
                       (start, end)).fetchall()
    sources = {}
    for ref, n in db.execute("SELECT referer, COUNT(*) FROM requests WHERE page = 1 AND ts >= ? AND ts < ? GROUP BY referer", (start, end)):
        src = source_of(ref)
        if src:
            sources[src] = sources.get(src, 0) + n
    top_src = sorted(sources.items(), key=lambda kv: -kv[1])[:3]
    fields.append(("👀 Visites", "\n".join(filter(None, [
        f"**{fr(views)}** pages vues{trend(views, views_prev)} · **{fr(visitors)}** visiteurs",
        "Sites : " + ", ".join(f"{SITE_NAMES.get(h, h)} {fr(n)}" for h, n in sites) if sites else None,
        "Sources : " + ", ".join(f"{k} {fr(v)}" for k, v in top_src) if top_src else None])), False))

    # CV et projets (beacons /_glsc/b.gif?e=…)
    cv_views = one("SELECT COUNT(*) FROM requests WHERE page = 1 AND host = 'cv.glsc.fr' AND ts >= ? AND ts < ?", (start, end))
    events = {}
    for q, n in db.execute("SELECT query, COUNT(*) FROM requests WHERE path = '/_glsc/b.gif' AND bot = 0 AND ts >= ? AND ts < ? GROUP BY query",
                           (start, end)):
        e = urllib.parse.parse_qs(q).get("e", [""])[0][:60]
        if e:
            events[e] = events.get(e, 0) + n
    cv_bits = [f"{fr(n)} {CV_EVENTS[e]}" for e, n in sorted(events.items(), key=lambda kv: -kv[1]) if e in CV_EVENTS][:4]
    projects = sorted(((e[8:], n) for e, n in events.items() if e.startswith("project:")), key=lambda kv: -kv[1])[:3]
    fields.append(("📄 CV & projets", "\n".join(filter(None, [
        f"CV vu **{fr(cv_views)}** fois" + (" · " + ", ".join(cv_bits) if cv_bits else ""),
        "Projets cliqués : " + ", ".join(f"{p} ({fr(n)})" for p, n in projects) if projects else None])), False))

    # Jeux
    lines = []
    for game, (label, _, _) in GAMES.items():
        matches = one("SELECT COUNT(DISTINCT match) FROM results WHERE game = ? AND ts >= ? AND ts < ?", (game, start, end))
        peak = one("SELECT MAX(conns) FROM games WHERE game = ? AND ts >= ? AND ts < ?", (game, start, end))
        order = "SUM(kills) DESC" if game == "vortex" else "SUM(won) DESC, COUNT(*) ASC"
        champ = None
        for key, name, wins, kills in db.execute(f"SELECT key, name, SUM(won), SUM(kills) FROM results WHERE game = ? AND ts >= ? AND ts < ? "
                                                 f"GROUP BY key ORDER BY {order} LIMIT 20", (game, start, end)):
            if name_ok(key) and (wins or kills):
                champ = f"👑 {name} ({fr(kills or 0)} élim.)" if game == "vortex" else f"👑 {name} ({fr(wins)} victoire{'s' if wins > 1 else ''})"
                break
        if matches or peak:
            unit = "partie" if game in ("uno", "petitbac") else "manche"
            lines.append(f"**{label}** : {fr(matches)} {unit}{'s' if matches > 1 else ''}" + (f", jusqu'à {peak} connectés" if peak else "")
                         + (f" · {champ}" if champ else ""))
    fields.append(("🎮 Jeux", "\n".join(lines) or "Personne n'a joué cette semaine.", False))

    # GitHub (cache de la page Projets : dates des commits hors merge, 90 jours)
    per_repo = {name: sum(1 for d in c.get("dates", []) if start <= d < end) for name, c in state.get("projects", {}).items()}
    commits = sum(per_repo.values())
    busiest = sorted(((n, r) for r, n in per_repo.items() if n), reverse=True)[:3]
    runs = load_json(os.path.join(pub_dir, "deploy-runs.json"), {}).get("runs", [])
    week_runs = [r for r in runs if start <= (r.get("start") or 0) < end]
    ok = sum(1 for r in week_runs if r.get("status") == "ok")
    fields.append(("🛠️ Code", "\n".join(filter(None, [
        f"**{fr(commits)}** commit{'s' if commits > 1 else ''}" + (" · " + ", ".join(f"{r} {n}" for n, r in busiest) if busiest else ""),
        f"{ok} déploiement{'s' if ok > 1 else ''} réussi{'s' if ok > 1 else ''}" + (f", **{len(week_runs) - ok} raté{'s' if len(week_runs) - ok > 1 else ''}**" if len(week_runs) > ok else "")
        if week_runs else None])), False))

    # Serveur
    status = load_json(status_file, {})
    incidents = []
    for i in status.get("incidents", []):
        try:
            t = int(dt.datetime.fromisoformat(i["start"].replace("Z", "+00:00")).timestamp())
        except (KeyError, ValueError, AttributeError):
            continue
        if start <= t < end:
            incidents.append(i)
    down = sum(int(i.get("duration_s") or 0) for i in incidents)
    ssh = one("SELECT COUNT(*) FROM ssh WHERE kind != 'accepted' AND ts >= ? AND ts < ?", (start, end))
    scans = one("SELECT COUNT(*) FROM requests WHERE scan = 1 AND ts >= ? AND ts < ?", (start, end))
    health = load_json(os.path.join(pub_dir, "health.json"), {})
    disk = health.get("disk") or {}
    certs = [c for c in health.get("certs", []) if c.get("days") is not None and c["days"] < 21]
    fields.append(("🖥️ Serveur", "\n".join(filter(None, [
        f"**{len(incidents)}** incident{'s' if len(incidents) > 1 else ''}" + (f" ({human(down)} d'indisponibilité : "
                                                                          + ", ".join(sorted({i['name'] for i in incidents})) + ")" if incidents else " 🎉"),
        f"{fr(ssh)} tentatives SSH refusées · {fr(scans)} requêtes de robots scanneurs",
        f"Disque : {disk['used'] * 100 // max(1, disk['total'])} % utilisé" if disk.get("total") else None,
        "⚠️ Certificats bientôt expirés : " + ", ".join(f"{c['domain']} ({c['days']} j)" for c in certs) if certs else None])), False))

    a = dt.datetime.fromtimestamp(start, TZ)
    b = dt.datetime.fromtimestamp(end - 1, TZ)
    months = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
    title = f"📊 Récap · {a.day} {months[a.month - 1]} → {b.day} {months[b.month - 1]}"
    return title, f"Ce qui s'est passé sur glsc.fr, du {a.strftime('%d/%m %H:%M')} au {b.strftime('%d/%m %H:%M')}.", fields


def human(sec):
    return f"{sec // 3600} h {sec % 3600 // 60:02d}" if sec >= 3600 else f"{max(1, sec // 60)} min"


def send_recap(db, state, now, args, settings):
    """Automatique : le lundi à partir de 9 h (Paris), une fois par semaine, sur la semaine écoulée."""
    local = dt.datetime.fromtimestamp(now, TZ)
    week = local.strftime("%G-%V")
    if local.weekday() != 0 or local.hour < 9 or state.get("recap_week") == week:
        return False
    state["recap_week"] = week  # même sans webhook ou alerte coupée : une seule tentative par semaine
    if settings.get("alert_weekly", "1") != "1":
        return False
    title, text, fields = weekly_recap(db, state, *week_bounds(now), args.pub_dir, args.status_json)
    return discord(settings.get("discord_webhook", ""), title, text, 0xC3A6FF, fields, url="https://admin.glsc.fr")


def recap_now(args, period="7j", preview=False):
    """À la demande (commande glsc-recap ou bouton de l'admin) : lit la copie publiée de la base, n'écrit rien."""
    now = int(time.time())
    start, end = week_bounds(now) if period == "semaine" else (now - 7 * 86400, now)
    pub_db = os.path.join(args.pub_dir, "metrics.db")
    if not os.path.exists(pub_db):
        raise SystemExit("Pas encore de mesures : la sonde n'a jamais tourné (deploy5).")
    db = sqlite3.connect(f"file:{pub_db}?mode=ro", uri=True)
    state = load_json(os.path.join(args.state_dir, "state.json"), {})
    title, text, fields = weekly_recap(db, state, start, end, args.pub_dir, args.status_json)
    db.close()
    if preview:
        print(title, "\n" + text)
        for name, value, _ in fields:
            print(f"\n{name}\n" + "\n".join("  " + line.replace("**", "") for line in value.splitlines()))
        return True
    hook = app_settings(args.app_db).get("discord_webhook", "")
    if not hook:
        raise SystemExit("Aucun webhook Discord : règle-le dans l'admin (Réglages).")
    return discord(hook, title, text, 0xC3A6FF, fields, url="https://admin.glsc.fr")


def www_gid():
    try:
        import grp
        return grp.getgrnam("www-data").gr_gid
    except (KeyError, ImportError):
        return None


def collect(args):
    now = int(time.time())
    os.makedirs(args.state_dir, exist_ok=True)
    os.makedirs(args.pub_dir, exist_ok=True)
    state_file = os.path.join(args.state_dir, "state.json")
    state = load_json(state_file, {})
    gid = www_gid()
    db = sqlite3.connect(os.path.join(args.state_dir, "work.db"))
    db.executescript(SCHEMA)
    if "pid" not in {r[1] for r in db.execute("PRAGMA table_info(results)")}:
        db.execute("ALTER TABLE results ADD COLUMN pid TEXT")  # profils joueurs (ajouté après coup)
    pub = lambda name: os.path.join(args.pub_dir, name + ".json")  # noqa: E731

    def step(name, fn):
        try:
            return fn()
        except Exception as e:  # une étape en échec ne bloque pas les autres
            log(f"{name} : {type(e).__name__}: {e}")
            return None

    n = step("logs nginx", lambda: ingest_log(db, state, args.log))
    hl = step("santé", lambda: health(db, state, now, args))
    if hl:
        write_json(pub("health"), hl, gid)
    dk = step("docker", lambda: docker_state(db, now)) if shutil.which("docker") else None
    if dk:
        write_json(pub("docker"), dk, gid)
    accepted = step("ssh", lambda: ssh_events(db, state, now)) or []
    step("résultats des jeux", lambda: ingest_results(db, state, args.games_data, now))
    hidden = set(json.loads(app_settings(args.app_db).get("games_hidden") or "[]"))
    profiles = load_profiles(args.games_data)
    extras = step("saisons et défis", lambda: compute_extras(db, now, hidden, profiles)) or {}
    boards = step("classements", lambda: leaderboards(db, now, hidden, profiles, extras.get("unlocks")))
    if boards:
        if extras:
            boards[0]["seasons"] = extras["champions"]
            boards[0]["daily"] = extras["challenge"]
        write_json(pub("leaderboard"), boards[1], gid)
        if os.path.isdir(os.path.dirname(args.leaderboard_json)):
            write_json(args.leaderboard_json, boards[0], mode=0o644)
    step("signalements", lambda: process_reports(args, state, app_settings(args.app_db), now))
    stats = step("joueurs", lambda: player_stats(db, now, hidden, profiles, args.pub_dir))
    if stats:
        write_json(pub("players-stats"), stats, gid)
    fiches = step("profils", lambda: players_page(db, now, hidden, profiles, extras))
    if fiches and os.path.isdir(os.path.dirname(args.leaderboard_json)):
        write_json(os.path.join(os.path.dirname(args.leaderboard_json), "players.json"), fiches, mode=0o644)
    if fiches and os.path.isdir(os.path.dirname(args.leaderboard_json)):
        step("cartes de profil", lambda: publish_cards(fiches, os.path.dirname(args.leaderboard_json), state))
    sec = {"at": now, "fail2ban": step("fail2ban", fail2ban)}
    write_json(pub("security"), sec, gid)
    if now - state.get("changelog_at", 0) >= 2400 and not args.offline and os.path.isdir(os.path.dirname(args.leaderboard_json)):
        state["changelog_at"] = now  # au plus 5 appels toutes les 40 min
        entries = step("nouveautés", lambda: changelog_entries(args.github_user))
        if entries:
            root = os.path.dirname(args.leaderboard_json)
            write_json(os.path.join(root, "changelog.json"), {"at": now, "entries": entries}, mode=0o644)
            tmp = os.path.join(root, "nouveautes.xml.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(changelog_atom(entries, now))
            os.chmod(tmp, 0o644)
            os.replace(tmp, os.path.join(root, "nouveautes.xml"))
    if now - state.get("github_at", 0) >= 900 and not args.offline:
        gh = step("github", lambda: github(args.github_user))
        state["github_at"] = now  # même en échec : pas plus d'un essai par 15 min (limite de l'API)
        if gh:
            repos = gh.pop("all")
            write_json(pub("github"), {**gh, "repos": repos[:18]}, gid)
            pj = step("projets", lambda: github_projects(args.github_user, repos, state, now))
            if pj and os.path.isdir(os.path.dirname(args.projects_json)):
                write_json(args.projects_json, pj, mode=0o644)
    if now - state.get("deploys_at", 0) >= 600:
        dp = step("déploiements", lambda: deploys(state, args.backups, args.games_src, args.version_file, now))
        if dp:
            write_json(pub("deploys"), dp, gid)
            state["deploys_at"] = now
    settings = app_settings(args.app_db)
    step("alertes", lambda: alerts(state, settings, now, hl, dk, accepted))
    step("webhook status", lambda: sync_status_webhook(state, settings, args.status_webhook))
    step("récap du lundi", lambda: send_recap(db, state, now, args, settings))

    # rétention : 35 jours de requêtes, 8 jours de mesures fines
    db.execute("DELETE FROM requests WHERE ts < ?", (now - 35 * 86400,))
    db.execute("DELETE FROM health WHERE ts < ?", (now - 8 * 86400,))
    db.execute("DELETE FROM games WHERE ts < ?", (now - 8 * 86400,))
    db.execute("DELETE FROM ssh WHERE ts < ?", (now - 35 * 86400,))
    db.execute("DELETE FROM results WHERE ts < ?", (now - 400 * 86400,))
    db.commit()
    if now - state.get("vacuum_at", 0) > 7 * 86400:
        db.execute("VACUUM")
        state["vacuum_at"] = now
    db.close()
    step("publication", lambda: publish_db(os.path.join(args.state_dir, "work.db"), os.path.join(args.pub_dir, "metrics.db"), gid))
    write_json(state_file, state)
    if args.verbose:
        log(f"{n or 0} requêtes lues")


# ---------------------------------------------------------------- file d'attente
def queue(args):
    settings = app_settings(args.app_db)
    hook = settings.get("discord_webhook", "")
    for path in sorted(glob.glob(os.path.join(args.queue_dir, "*.json"))):
        try:
            if os.path.getsize(path) > 65536:
                raise ValueError("fichier trop gros")
            job = load_json(path, {})
            kind, data = job.get("type"), job.get("data") or {}
            if time.time() - int(job.get("at", 0)) > 3600:
                log("demande trop ancienne ignorée :", os.path.basename(path))
            elif kind == "recap":
                log("récap à la demande :", "envoyé" if recap_now(args, "semaine" if data.get("period") == "semaine" else "7j") else "échec")
            elif kind == "backup":
                ok = subprocess.run(["systemctl", "start", "--no-block", "glsc-backup.service"], capture_output=True, timeout=30, check=False).returncode == 0
                log("sauvegarde à la demande :", "lancée" if ok else "échec")
            elif kind == "discord":
                discord(hook, str(data.get("title", ""))[:200], str(data.get("text", ""))[:1500])
            elif kind == "restart" and data.get("game") in GAMES:
                name = f"glsc-games-{data['game']}-1"
                ok = subprocess.run(["docker", "restart", name], capture_output=True, timeout=90, check=False).returncode == 0
                log(f"redémarrage de {name} :", "ok" if ok else "échec")
                if not ok:
                    discord(hook, f"⚠️ Redémarrage de {GAMES[data['game']][0]} raté", "Regarde `docker logs " + name + "` sur le serveur.", 0xEF4444)
            else:
                log("demande inconnue ignorée :", kind)
        except Exception as e:
            log("file d'attente :", os.path.basename(path), e)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

# ---------------------------------------------------------------- sauvegardes chiffrées
BACKUP_ETC = os.environ.get("GLSC_BACKUP_ETC", "/etc/glsc-backup")
BACKUP_DIR = os.environ.get("GLSC_BACKUP_DIR", "/var/backups/glsc")
BACKUP_KEEP = 14  # archives gardées en local ; ailleurs : 60 jours (rclone)
BACKUP_PATHS = [  # tout ce qu'on perdrait avec le serveur ; les bases SQLite sont copiées à part (copie cohérente)
    "/etc/glsc-admin", "/etc/glsc-status", "/etc/glsc-backup/remote", "/var/lib/glsc-status", "/var/lib/glsc-games",
    "/opt/glsc-games/compose.yml", "/etc/nginx/sites-available", "/etc/nginx/conf.d", "/etc/nginx/glsc-404.inc",
    "/etc/letsencrypt", "/etc/systemd/system/glsc-*", "/etc/fail2ban/jail.d", "/etc/ssh/sshd_config.d",
]


def read_line(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.readline().strip()
    except OSError:
        return ""


def discord_file(webhook, path, text):
    """Envoie un fichier (déjà chiffré) sur Discord ; limite prudente de 8 Mo."""
    import uuid
    boundary = uuid.uuid4().hex
    with open(path, "rb") as f:
        blob = f.read()
    parts = [f"--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n".encode(),
             json.dumps({"username": "glsc.fr", "content": text}).encode(),
             f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"{os.path.basename(path)}\"\r\nContent-Type: application/octet-stream\r\n\r\n".encode(),
             blob, f"\r\n--{boundary}--\r\n".encode()]
    req = urllib.request.Request(webhook, data=b"".join(parts), method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": "glsc-admin"})
    urllib.request.urlopen(req, timeout=60).close()


def backup(args):
    import tarfile
    import tempfile
    now = int(time.time())
    gid = www_gid()
    status = {"at": now, "ok": False, "configured": False, "name": None, "size": 0, "local": 0, "offsite": None, "error": None,
              "last_ok": load_json(os.path.join(args.pub_dir, "backup.json"), {}).get("last_ok")}
    settings = app_settings(args.app_db)
    hook = settings.get("discord_webhook", "")

    def finish(error=None):
        status["error"] = error
        status["ok"] = error is None
        if status["ok"]:
            status["last_ok"] = now
        write_json(os.path.join(args.pub_dir, "backup.json"), status, gid)
        if error:
            log("sauvegarde :", error)
            if settings.get("alert_backup", "1") == "1" and status["configured"]:
                discord(hook, "❌ Sauvegarde ratée", error[:1500], 0xEF4444)
        return error is None

    recipient = read_line(os.path.join(BACKUP_ETC, "recipient"))
    if not recipient.startswith("age1"):
        return finish("Sauvegarde non configurée : lance « glsc-backup-setup » sur le serveur.")
    status["configured"] = True
    if not shutil.which("age"):
        return finish("Le programme « age » est absent : relance « glsc-backup-setup ».")
    os.makedirs(BACKUP_DIR, mode=0o700, exist_ok=True)
    os.chmod(BACKUP_DIR, 0o700)
    name = time.strftime("glsc-%Y%m%d-%H%M%S", time.localtime(now)) + ".tar.gz.age"
    out_path = os.path.join(BACKUP_DIR, name)
    try:
        with tempfile.TemporaryDirectory(prefix="snap-", dir=BACKUP_DIR) as snap:
            # bases SQLite : copie cohérente même si PHP ou la sonde écrivent en ce moment
            for sub in ("app", "collector"):
                for db in glob.glob(os.path.join(args.var, sub, "*.db")):
                    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=10)
                    dst = sqlite3.connect(os.path.join(snap, f"{sub}-{os.path.basename(db)}"))
                    con.backup(dst)
                    dst.close()
                    con.close()
            skip = (".db", ".db-wal", ".db-shm")
            proc = subprocess.Popen(["age", "-r", recipient, "-o", out_path], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
            with tarfile.open(fileobj=proc.stdin, mode="w|gz") as tar:
                tar.add(snap, arcname="bases")
                tar.add(os.path.join(args.var, "app"), arcname="admin-app", filter=lambda t: None if t.name.endswith(skip) else t)
                for spec in BACKUP_PATHS:
                    for path in glob.glob(spec):
                        tar.add(path, arcname=path.lstrip("/"))
            proc.stdin.close()
            err = proc.stderr.read().decode(errors="replace")
            if proc.wait() != 0:
                raise RuntimeError("age a échoué : " + err[-300:])
        os.chmod(out_path, 0o600)
    except Exception as e:
        try:
            os.remove(out_path)
        except OSError:
            pass
        return finish(f"{type(e).__name__}: {e}")
    status.update(name=name, size=os.path.getsize(out_path))
    # conservation locale
    old = sorted(glob.glob(os.path.join(BACKUP_DIR, "glsc-*.tar.gz.age")))
    for p in old[:-BACKUP_KEEP]:
        os.remove(p)
    status["local"] = min(len(old), BACKUP_KEEP)
    # hors du serveur
    remote = read_line(os.path.join(BACKUP_ETC, "remote"))
    problems = []
    if remote and shutil.which("rclone"):
        r = subprocess.run(["rclone", "copyto", out_path, remote.rstrip("/") + "/" + name], capture_output=True, text=True, timeout=900, check=False)
        if r.returncode == 0:
            status["offsite"] = "rclone"
            subprocess.run(["rclone", "delete", remote, "--min-age", "60d", "--include", "glsc-*.tar.gz.age"], capture_output=True, timeout=300, check=False)
        else:
            problems.append("envoi rclone raté : " + (r.stderr or "")[-300:])
    elif remote:
        problems.append("rclone n'est pas installé")
    if status["offsite"] is None and os.path.exists(os.path.join(BACKUP_ETC, "discord")) and hook:
        if status["size"] <= 8 * 1024 * 1024:
            try:
                discord_file(hook, out_path, f"🔐 Sauvegarde chiffrée du {time.strftime('%d/%m/%Y %H:%M', time.localtime(now))} (illisible sans ta clé privée).")
                status["offsite"] = "discord"
            except OSError as e:
                problems.append(f"envoi Discord raté : {e}")
        else:
            problems.append("archive trop grosse pour Discord (8 Mo) : configure rclone")
    if problems:
        return finish("Archive faite et gardée sur le serveur, mais pas envoyée ailleurs : " + " ; ".join(problems))
    log(f"sauvegarde : {name} ({status['size'] // 1024} Ko), hors serveur : {status['offsite'] or 'non configuré'}")
    return finish()


# ---------------------------------------------------------------- déploiement automatique
REPO_TGZ = os.environ.get("GLSC_DEPLOY_TGZ", "https://codeload.github.com/gabinlsc/portfolio/tar.gz/refs/heads/main")  # surchargé par les tests
DEPLOY_PLANS = {  # cible → scripts du dépôt portfolio à lancer, avec leurs variables d'environnement
    "portfolio": [("deploy/deploy3.sh", {}), ("deploy/deploy5.sh", {"GLSC_ONLY_ADMIN": "1"})],
    "portfolio-full": [("deploy/deploy5.sh", {})],
    "uno": [("deploy/deploy4.sh", {"GLSC_ONLY_GAME": "uno"})],
    "president": [("deploy/deploy4.sh", {"GLSC_ONLY_GAME": "president"})],
    "petitbac": [("deploy/deploy4.sh", {"GLSC_ONLY_GAME": "petitbac"})],
    "vortex": [("deploy/deploy4.sh", {"GLSC_ONLY_GAME": "vortex"})],
}
DEPLOY_STEP_TIMEOUT = 40 * 60
# adresses qui doivent répondre après un déploiement du portfolio ; sinon on revient à la dernière version qui marchait
DEPLOY_VERIFY = [u for u in os.environ.get("GLSC_DEPLOY_VERIFY", "https://glsc.fr/,https://admin.glsc.fr/,https://status.glsc.fr/").split(",") if u]
ROLLBACK_CODE = 3  # code de sortie de deploy4 : « raté, mais l'ancienne version du jeu est remise en service »
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def deploy_requests(args):
    """Lit et supprime les demandes en attente ; une seule exécution par cible (la plus récente gagne)."""
    wanted = {}
    for path in sorted(glob.glob(os.path.join(args.deploy_dir, "*.json"))):
        try:
            if os.path.getsize(path) > 8192:
                raise ValueError("fichier trop gros")
            req = load_json(path, {})
            target = req.get("target")
            if target not in DEPLOY_PLANS:
                log("déploiement : cible inconnue ignorée :", target)
            elif time.time() - int(req.get("at", 0)) > 6 * 3600:
                log("déploiement : demande trop ancienne ignorée")
            else:
                wanted[target] = {k: str(req.get(k, ""))[:200] for k in ("sha", "message", "by", "source")}
        except Exception as e:
            log("déploiement :", os.path.basename(path), e)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
    if "portfolio-full" in wanted:
        wanted.pop("portfolio", None)
    order = ["portfolio-full", "portfolio", "uno", "president", "petitbac", "vortex"]
    return [(t, wanted[t]) for t in order if t in wanted]


def deploy_publish(args, runs, gid):
    write_json(os.path.join(args.pub_dir, "deploy-runs.json"), {"at": int(time.time()), "runs": runs[:30]}, gid)
    keep = {r["id"] for r in runs[:30]}
    for p in glob.glob(os.path.join(args.pub_dir, "deploy-logs", "*.log")):
        if os.path.basename(p)[:-4] not in keep:
            os.remove(p)


def fetch_source(work, url, name):
    """Télécharge et extrait l'archive du dépôt ; renvoie (dossier, sha du commit si l'archive le dit)."""
    import tarfile
    tgz = os.path.join(work, name + ".tgz")
    dest = os.path.join(work, name)
    os.makedirs(dest)
    urllib.request.urlretrieve(url, tgz)
    with tarfile.open(tgz) as tar:
        sha = str(tar.pax_headers.get("comment", "")).strip()
        tar.extractall(dest, filter="data")
    src = next(p for p in glob.glob(os.path.join(dest, "*")) if os.path.isdir(p))
    return src, sha if re.fullmatch(r"[0-9a-f]{40}", sha) else ""


def tgz_url(sha):
    """Archive d'un commit précis (retour arrière) ; les tests, qui fixent l'archive, la gardent telle quelle."""
    return REPO_TGZ.replace("refs/heads/main", sha) if "refs/heads/main" in REPO_TGZ else REPO_TGZ


def deploy_verify():
    """Adresses du portfolio qui ne répondent pas (code ≥ 400 ou aucune réponse) après un déploiement."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    bad = []
    for url in DEPLOY_VERIFY:
        code = None
        for _ in range(3):
            try:
                code = opener.open(urllib.request.Request(url, headers={"User-Agent": "glsc-deploy"}), timeout=8).status
            except urllib.error.HTTPError as e:
                code = e.code
            except Exception:
                code = None
            if code is not None and code < 400:
                break
            time.sleep(2)
        if code is None or code >= 400:
            bad.append(f"{url} ({code or 'pas de réponse'})")
    return bad


def last_good_commit(runs):
    for r in runs:
        if r.get("status") == "ok" and r.get("commit") and r.get("target") in ("portfolio", "portfolio-full"):
            return r["commit"]
    return ""


def deploy_run(args, target, info, runs, gid, hook, alert_on):
    import tarfile
    import tempfile
    start = time.time()
    run_id = time.strftime("%Y%m%d-%H%M%S", time.localtime(start)) + "-" + target
    logs = os.path.join(args.pub_dir, "deploy-logs")
    os.makedirs(logs, exist_ok=True)
    gid = gid if gid is not None else -1
    os.chown(logs, 0, gid)
    os.chmod(logs, 0o750)
    log_path = os.path.join(logs, run_id + ".log")
    entry = {"id": run_id, "target": target, **info, "start": int(start), "end": None, "status": "running", "step": None}
    runs.insert(0, entry)
    deploy_publish(args, runs, gid)
    code = 0
    with open(log_path, "w", encoding="utf-8") as out, tempfile.TemporaryDirectory(prefix="glsc-deploy-") as work:
        os.chown(log_path, 0, gid)
        os.chmod(log_path, 0o640)  # journal réservé à root et à l'admin (www-data)

        def note(text):
            out.write(text + "\n")
            out.flush()

        try:
            note(f"== {time.strftime('%d/%m/%Y %H:%M:%S')} · déploiement « {target} »" + (f" · {info['sha'][:7]} {info['message']}" if info.get("sha") else ""))
            note("== téléchargement du dépôt portfolio")
            src, commit = fetch_source(work, REPO_TGZ, "src")
            entry["commit"] = commit
            env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "LANG": "C.UTF-8",
                   "TERM": "dumb", "GLSC_AUTO_DEPLOY": "1"}

            def run_plan(src_dir):
                last = 0
                for script, extra in DEPLOY_PLANS[target]:
                    entry["step"] = os.path.basename(script) + "".join(f" {k}={v}" for k, v in extra.items())
                    deploy_publish(args, runs, gid)
                    note(f"\n== {entry['step']}")
                    proc = subprocess.Popen(["bash", os.path.join(src_dir, script)], cwd=work, env={**env, **extra}, stdin=subprocess.DEVNULL,
                                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", start_new_session=True)
                    watchdog = threading.Timer(DEPLOY_STEP_TIMEOUT, lambda p=proc: os.killpg(p.pid, 9))  # script bloqué : on coupe tout
                    watchdog.start()
                    try:
                        for line in proc.stdout:
                            out.write(ANSI.sub("", line))
                        last = proc.wait()
                    finally:
                        watchdog.cancel()
                    if last == -9:
                        note(f"!! délai de {DEPLOY_STEP_TIMEOUT // 60} min dépassé, script arrêté")
                    out.flush()
                    if last != 0:
                        note(f"!! {os.path.basename(script)} a échoué (code {last})")
                        break
                return last

            portfolio_target = target in ("portfolio", "portfolio-full")
            good = last_good_commit(runs[1:])  # dernière version qui a marché, avant ce déploiement
            code = run_plan(src)
            if code == ROLLBACK_CODE and not portfolio_target:
                entry["rollback"] = True  # deploy4 a déjà remis l'ancienne version du jeu
            elif portfolio_target:
                problems = [] if code != 0 else deploy_verify()
                if code == 0 and problems:
                    note("!! après le déploiement, ne répond pas : " + ", ".join(problems))
                if (code != 0 or problems) and good and good != commit:
                    note(f"\n== retour arrière vers la version {good[:7]}")
                    old_src, _ = fetch_source(work, tgz_url(good), "old")
                    back = run_plan(old_src)
                    again = [] if back != 0 else deploy_verify()
                    if back == 0 and not again:
                        note("== l'ancienne version est remise en service")
                        entry["rollback"] = True
                        code = ROLLBACK_CODE
                    else:
                        note("!! le retour arrière n'a pas suffi" + (" : " + ", ".join(again) if again else ""))
                        code = code or 1
                elif problems:
                    code = 1
        except Exception as e:
            code = code or 1
            note(f"!! {type(e).__name__}: {e}")
    entry.update(end=int(time.time()), status="ok" if code == 0 else "rollback" if entry.get("rollback") else "fail", code=code, step=None)
    deploy_publish(args, runs, gid)
    took = entry["end"] - entry["start"]
    took_txt = f"{took // 60} min {took % 60:02d} s" if took >= 60 else f"{took} s"
    what = f"`{info['sha'][:7]}` {info['message']}" if info.get("sha") else "lancé depuis l'admin"
    log(f"déploiement {target} :", entry["status"], took_txt)
    if alert_on:
        if code == 0:
            discord(hook, f"✅ {target} déployé", f"{what}\nDurée : {took_txt}", 0x22C55E)
        elif entry["status"] == "rollback":
            discord(hook, f"↩️ {target} : mise à jour annulée", f"{what}\nLa nouvelle version ne répondait pas : la précédente a été remise en service automatiquement.\nJournal dans l'admin (GitHub & déploiements).", 0xF59E0B)
        else:
            try:
                with open(log_path, encoding="utf-8") as f:
                    tail = "".join(f.readlines()[-12:])[-1500:]
            except OSError:
                tail = ""
            discord(hook, f"❌ Déploiement de {target} raté", f"{what}\nJournal complet dans l'admin (GitHub & déploiements).\n```\n{tail}\n```", 0xEF4444)
    return code


def deploy(args):
    import fcntl
    # Les scripts de déploiement doivent tourner avec le masque habituel (022), comme lancés à la main :
    # avec celui de la sonde (027), les sources clonées deviennent illisibles pour l'utilisateur des conteneurs
    # (+4 lit ses fichiers à l'exécution) et les dossiers créés pour nginx aussi.
    os.umask(0o022)
    gid = www_gid()
    os.makedirs("/run/lock", exist_ok=True)
    with open("/run/lock/glsc-deploy.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            log("un déploiement est déjà en cours : les demandes attendront la fin")
            return
        runs = load_json(os.path.join(args.pub_dir, "deploy-runs.json"), {}).get("runs", [])
        for r in runs:  # un déploiement interrompu (redémarrage du serveur…) n'est plus « en cours »
            if r.get("status") == "running":
                r.update(status="fail", end=r.get("end") or int(time.time()), step=None)
        while True:
            todo = deploy_requests(args)
            if not todo:
                break
            settings = app_settings(args.app_db)
            for target, info in todo:
                deploy_run(args, target, info, runs, gid, settings.get("discord_webhook", ""), settings.get("alert_deploy", "1") == "1")
        deploy_publish(args, runs, gid)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["collect", "queue", "deploy", "recap", "backup"])
    ap.add_argument("--semaine", action="store_true", help="recap : la semaine dernière complète (lundi → dimanche) au lieu des 7 derniers jours")
    ap.add_argument("--apercu", action="store_true", help="recap : affiche le récap ici sans l'envoyer sur Discord")
    ap.add_argument("--var", default="/var/lib/glsc-admin", help="dossier de données de l'admin")
    ap.add_argument("--log", default="/var/log/nginx/glsc-access.log")
    ap.add_argument("--letsencrypt", default="/etc/letsencrypt/live")
    ap.add_argument("--backups", default="/root/glsc-backups")
    ap.add_argument("--games-src", default="/opt/glsc-games/src")
    ap.add_argument("--games-data", default="/var/lib/glsc-games", help="results.jsonl de chaque jeu")
    ap.add_argument("--leaderboard-json", default="/var/www/games.glsc.fr/leaderboard.json", help="classements publics")
    ap.add_argument("--version-file", default="/etc/glsc-admin/portfolio-version.json")
    ap.add_argument("--status-webhook", default="/etc/glsc-status/discord-webhook")
    ap.add_argument("--status-json", default="/var/www/status.glsc.fr/status.json", help="incidents (récap du lundi)")
    ap.add_argument("--github-user", default="gabinlsc")
    ap.add_argument("--projects-json", default="/var/www/share.glsc.fr/github.json", help="activité publique lue par la page Projets")
    ap.add_argument("--offline", action="store_true", help="ne pas appeler GitHub (tests)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    args.state_dir = os.path.join(args.var, "collector")
    args.pub_dir = os.path.join(args.var, "pub")
    args.queue_dir = os.path.join(args.var, "queue")
    args.deploy_dir = os.path.join(args.var, "deploy")
    args.app_db = os.path.join(args.var, "app", "app.db")
    os.umask(0o027)
    if args.command == "collect":
        collect(args)
    elif args.command == "deploy":
        deploy(args)
    elif args.command == "backup":
        sys.exit(0 if backup(args) else 1)
    elif args.command == "recap":
        ok = recap_now(args, "semaine" if args.semaine else "7j", args.apercu)
        print("Récap envoyé sur Discord." if ok and not args.apercu else "" if ok else "Envoi impossible (voir le message ci-dessus).")
        sys.exit(0 if ok else 1)
    else:
        queue(args)


if __name__ == "__main__":
    main()
