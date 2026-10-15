// Partage de fichiers : dépôt (glisser-déposer), lien public qui expire, limite de téléchargements.
import { h, clear, api, attempt, icon, sectionHead, card, bytes, iconBtn, confirmBox, copy, emptyState, pill, toast, modal } from '../lib.js';
import { qrSvg } from './short.js';

const TTL = [['1h', '1 heure'], ['1d', '1 jour'], ['7d', '7 jours'], ['30d', '30 jours']];

export async function render(root) {
  const data = await api('files/list');
  const list = h('div', {});
  const set = (files) => clear(list, files.length ? h('div', { class: 'stack-sm' }, files.map((f) => row(f, set))) : emptyState('Aucun fichier partagé.'));
  root.append(sectionHead('Fichiers', `Dépose un fichier (${bytes(data.max)} max), partage le lien, il disparaît tout seul.`), uploader(set), list);
  set(data.files);
}

function uploader(set) {
  const input = h('input', { type: 'file', class: 'sr-only', id: 'file-input' });
  const ttl = h('select', { class: 'input input-sm', 'aria-label': 'Durée' }, TTL.map(([v, l]) => h('option', { value: v, selected: v === '1d' || null }, l)));
  const max = h('select', { class: 'input input-sm', 'aria-label': 'Téléchargements' },
    [['', 'illimités'], ['1', '1 seul'], ['3', '3'], ['10', '10']].map(([v, l]) => h('option', { value: v }, l)));
  const progress = h('div', { class: 'progress', hidden: true }, h('span', { class: 'progress-fill c-mint' }));
  const zone = h('label', { class: 'dropzone', for: 'file-input' }, icon('upload'), h('b', {}, 'Glisse un fichier ici'), h('span', { class: 'muted' }, 'ou clique pour choisir'));

  const send = (file) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('ttl', ttl.value);
    if (max.value) fd.append('max_downloads', max.value);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/upload');
    xhr.setRequestHeader('X-CSRF-Token', document.querySelector('meta[name="csrf-token"]').content);
    progress.hidden = false;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) progress.firstChild.style.width = `${(100 * e.loaded) / e.total}%`; };
    xhr.onload = () => {
      progress.hidden = true;
      progress.firstChild.style.width = '0';
      let d = {};
      try { d = JSON.parse(xhr.responseText); } catch { d = { error: xhr.status === 413 ? 'Fichier trop gros.' : 'Envoi refusé.' }; }
      if (xhr.status >= 200 && xhr.status < 300) { set(d.files); toast('Fichier envoyé ✓', 'good'); } else toast(d.error || 'Envoi refusé.', 'bad');
    };
    xhr.onerror = () => { progress.hidden = true; toast('Envoi interrompu.', 'bad'); };
    xhr.send(fd);
  };
  input.addEventListener('change', () => { if (input.files[0]) send(input.files[0]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files[0]) send(e.dataTransfer.files[0]); });

  return card(null, h('div', { class: 'stack-sm' }, input, zone,
    h('div', { class: 'row' }, h('label', { class: 'inline' }, 'Disponible ', ttl), h('label', { class: 'inline' }, 'Téléchargements ', max)), progress));
}

function row(f, set) {
  const url = `${location.origin}/f/${f.token}`;
  const left = f.expires - Date.now() / 1000;
  const expire = left > 86400 ? `${Math.round(left / 86400)} j` : left > 3600 ? `${Math.round(left / 3600)} h` : `${Math.max(1, Math.round(left / 60))} min`;
  return h('article', { class: 'card file-row' },
    h('div', { class: 'file-icon', 'aria-hidden': 'true' }, icon('file')),
    h('div', { class: 'grow' },
      h('b', { class: 'ellipsis block' }, f.name),
      h('small', { class: 'muted' }, `${bytes(f.size)} · expire dans ${expire} · ${f.downloads}${f.max_downloads ? '/' + f.max_downloads : ''} téléchargement(s)`)),
    pill(f.mime.split('/')[0], 'paper', 'pill-sm'),
    iconBtn('copy', 'Copier le lien', () => copy(url, 'Lien copié')),
    iconBtn('qr-code', 'QR code', () => modal({ title: f.name, body: h('div', { class: 'center' }, qrSvg(url, 6)) })),
    iconBtn('trash-2', 'Supprimer', async () => {
      if (!(await confirmBox(`Supprimer « ${f.name} » ? Le lien ne marchera plus.`))) return;
      const r = await attempt(() => api('files/delete', { body: { id: f.id } }));
      if (r) set(r.files);
    }));
}

