/* =========================================================
   PhotoApp — lógica principal (agora com IndexedDB)
   ========================================================= */
(function () {
  'use strict';

  const MAX_WIDTH = 1200;          // podemos aumentar! IDB não tem o limite do LS
  const JPEG_QUALITY = 0.78;       // qualidade um pouco maior

  // ---------- Elementos ----------
  const $ = (id) => document.getElementById(id);
  const video       = $('video');
  const canvas      = $('canvas');
  const btnStart    = $('btnStartCam');
  const btnCapture  = $('btnCapture');
  const btnStop     = $('btnStopCam');
  const camStatus   = $('camStatus');
  const gallery     = $('gallery');
  const emptyMsg    = $('emptyMsg');
  const stats       = $('stats');
  const filterFrom  = $('filterFrom');
  const filterTo    = $('filterTo');
  const btnClearFil = $('btnClearFilter');
  const btnExport   = $('btnExport');
  const importFile  = $('importFile');
  const btnClearAll = $('btnClearAll');
  const btnServerBk = $('btnServerBackup');
  const modal       = $('modal');
  const modalImg    = $('modalImg');
  const modalMeta   = $('modalMeta');
  const modalClose  = $('modalClose');

  let stream = null;
  let sortable = null;
  let currentPhotos = [];       // cache das fotos filtradas exibidas
  const urlCache = new Map();   // id -> objectURL (liberar ao remover)

  // ---------- Helpers ----------
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function urlFor(photo) {
    if (urlCache.has(photo.id)) return urlCache.get(photo.id);
    const url = URL.createObjectURL(photo.blob);
    urlCache.set(photo.id, url);
    return url;
  }
  function releaseUrl(id) {
    const u = urlCache.get(id);
    if (u) { URL.revokeObjectURL(u); urlCache.delete(id); }
  }
  function releaseAllUrls() {
    urlCache.forEach((u) => URL.revokeObjectURL(u));
    urlCache.clear();
  }

  // ---------- Câmera ----------
  async function startCamera() {
    try {
      camStatus.textContent = 'Solicitando permissão…';
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      btnCapture.disabled = false;
      btnStop.disabled = false;
      btnStart.disabled = true;
      camStatus.textContent = '✅ Câmera ativa.';
    } catch (err) {
      console.error(err);
      camStatus.textContent = '❌ Não foi possível abrir a câmera: ' + err.message +
        ' (necessário HTTPS ou localhost)';
    }
  }

  function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    video.srcObject = null;
    btnCapture.disabled = true;
    btnStop.disabled = true;
    btnStart.disabled = false;
    camStatus.textContent = 'Câmera parada.';
  }

  async function capturePhoto() {
    if (!stream) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { alert('Vídeo ainda não pronto.'); return; }

    const scale = Math.min(1, MAX_WIDTH / vw);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    canvas.width = w; canvas.height = h;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h);

    // Marca d'água
    const now = new Date();
    const stamp = fmtDateTime(now.toISOString());
    const fontSize = Math.max(14, Math.round(w * 0.028));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    const padding = Math.round(fontSize * 0.5);
    const metrics = ctx.measureText(stamp);
    const boxW = metrics.width + padding * 2;
    const boxH = fontSize + padding * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, h - boxH, boxW, boxH);
    ctx.fillStyle = '#fff';
    ctx.fillText(stamp, padding, h - padding);

    // Blob em vez de Base64 → economia de ~33%
    const blob = await new Promise(res =>
      canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY)
    );
    if (!blob) { alert('Falha ao converter imagem.'); return; }

    try {
      await PhotoDB.addPhoto({ blob, timestamp: now.toISOString() });
      video.style.filter = 'brightness(2)';
      setTimeout(() => (video.style.filter = ''), 120);
      await renderGallery();
    } catch (err) {
      console.error(err);
      alert('Erro ao salvar no IndexedDB: ' + err.message);
    }
  }

  // ---------- Renderização ----------
  async function getFilteredPhotos() {
    const from = filterFrom.value ? new Date(filterFrom.value + 'T00:00:00') : null;
    const to   = filterTo.value   ? new Date(filterTo.value   + 'T23:59:59') : null;
    return PhotoDB.getByDateRange(from, to);
  }

  async function renderGallery() {
    // Libera URLs que não serão mais usadas (economiza memória)
    const filtered = await getFilteredPhotos();
    currentPhotos = filtered;

    const keepIds = new Set(filtered.map(p => p.id));
    for (const id of Array.from(urlCache.keys())) {
      if (!keepIds.has(id)) releaseUrl(id);
    }

    gallery.innerHTML = '';
    emptyMsg.style.display = filtered.length ? 'none' : 'block';

    for (const p of filtered) {
      const card = document.createElement('div');
      card.className = 'photo-card';
      card.dataset.id = p.id;

      const img = document.createElement('img');
      img.src = urlFor(p);
      img.alt = 'Foto';
      img.loading = 'lazy';
      img.addEventListener('click', () => openModal(p));

      const meta = document.createElement('div');
      meta.className = 'photo-meta';
      meta.textContent = fmtDateTime(p.timestamp);

      const del = document.createElement('button');
      del.className = 'photo-del';
      del.title = 'Apagar foto';
      del.textContent = '×';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Apagar esta foto?')) return;
        try {
          await PhotoDB.deletePhoto(p.id);
          releaseUrl(p.id);
          await renderGallery();
        } catch (err) {
          alert('Erro ao apagar: ' + err.message);
        }
      });

      card.append(img, meta, del);
      gallery.appendChild(card);
    }

    setupSortable(filtered);
    await updateStats(filtered.length);
  }

  function setupSortable(filtered) {
    if (sortable) sortable.destroy();
    sortable = Sortable.create(gallery, {
      animation: 180,
      ghostClass: 'sortable-ghost',
      onEnd: async () => {
        const visibleIds = Array.from(gallery.children).map(c => c.dataset.id);
        // Recria a lista completa respeitando posições originais (compatível com filtro)
        const all = await PhotoDB.getAll();
        const visibleSet = new Set(visibleIds);
        const positions = [];
        all.forEach((p, i) => { if (visibleSet.has(p.id)) positions.push(i); });
        const reordered = [...all];
        visibleIds.forEach((id, i) => {
          const photo = all.find(p => p.id === id);
          reordered[positions[i]] = photo;
        });
        try {
          await PhotoDB.reorderByIds(reordered.map(p => p.id));
          // atualiza cache local de orders (sem re-render completo)
          currentPhotos.forEach((cp, i) => {
            const idx = visibleIds.indexOf(cp.id);
            if (idx >= 0) cp.order = positions[idx];
          });
        } catch (err) {
          console.error(err);
          alert('Erro ao salvar ordem: ' + err.message);
        }
      },
    });
  }

  async function updateStats(shownCount) {
    const total = await PhotoDB.count();
    const usage = await PhotoDB.estimateUsage();
    let usageTxt = '';
    if (usage && usage.quota) {
      const usedMB = (usage.usage / 1024 / 1024).toFixed(1);
      const quotaMB = (usage.quota / 1024 / 1024).toFixed(0);
      usageTxt = ` • 💾 ${usedMB} MB / ~${quotaMB} MB`;
    }
    stats.textContent = `📊 ${shownCount} de ${total} foto(s) exibida(s)${usageTxt}.`;
  }

  // ---------- Modal ----------
  function openModal(photo) {
    modalImg.src = urlFor(photo);
    modalMeta.textContent = '📅 ' + fmtDateTime(photo.timestamp);
    modal.classList.remove('hidden');
  }
  function closeModal() {
    modal.classList.add('hidden');
    modalImg.src = '';
  }

  // ---------- Backup ----------
  async function exportBackup() {
    const payload = await PhotoDB.exportToJSON();
    if (!payload.photos.length) { alert('Nada para exportar.'); return; }
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `photoapp-backup-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        const photos = await PhotoDB.importFromPayload(data);
        if (!photos.length) throw new Error('Nenhuma foto válida encontrada.');

        const merge = confirm(
          `Importar ${photos.length} foto(s).\n\nOK = MESCLAR com as existentes.\nCancelar = SUBSTITUIR tudo.`
        );

        if (merge) {
          const added = await PhotoDB.mergePhotos(photos);
          alert(`✅ Importação concluída. ${added} nova(s) foto(s) adicionada(s).`);
        } else {
          await PhotoDB.replaceAll(photos);
          alert(`✅ Importação concluída. Total agora: ${photos.length} foto(s).`);
        }
        releaseAllUrls();
        await renderGallery();
      } catch (err) {
        console.error(err);
        alert('❌ Falha ao importar: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  async function sendBackupToServer() {
    const payload = await PhotoDB.exportToJSON();
    if (!payload.photos.length) { alert('Nada para enviar.'); return; }
    try {
      const res = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos: payload.photos }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Erro desconhecido');
      alert(`☁️ Backup salvo no servidor: ${json.file} (${json.count} fotos)`);
    } catch (err) {
      alert('❌ Falha ao enviar: ' + err.message);
    }
  }

  // ---------- Eventos ----------
  btnStart.addEventListener('click', startCamera);
  btnCapture.addEventListener('click', capturePhoto);
  btnStop.addEventListener('click', stopCamera);
  btnExport.addEventListener('click', exportBackup);
  btnServerBk.addEventListener('click', sendBackupToServer);
  btnClearFil.addEventListener('click', async () => {
    filterFrom.value = ''; filterTo.value = '';
    await renderGallery();
  });
  filterFrom.addEventListener('change', renderGallery);
  filterTo.addEventListener('change', renderGallery);

  importFile.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importBackup(f);
    e.target.value = '';
  });

  btnClearAll.addEventListener('click', async () => {
    if (!confirm('Apagar TODAS as fotos? Isso não pode ser desfeito.')) return;
    try {
      await PhotoDB.clearAll();
      releaseAllUrls();
      await renderGallery();
    } catch (err) {
      alert('Erro ao apagar: ' + err.message);
    }
  });

  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // ---------- Init ----------
  (async function init() {
    try {
      // Migração única: LS → IDB
      const mig = await PhotoDB.migrateFromLocalStorage();
      if (mig.migrated > 0) {
        console.log(`📦 Migração concluída: ${mig.migrated} foto(s) movida(s) do LocalStorage para IndexedDB.`);
      }
      await renderGallery();
    } catch (err) {
      console.error(err);
      stats.textContent = '❌ Falha ao inicializar o banco: ' + err.message;
    }
  })();

  // Libera URLs ao fechar (boa prática)
  window.addEventListener('beforeunload', releaseAllUrls);
})();

  // ---------- Init ----------
  renderGallery();
})();
