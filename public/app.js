/* =========================================================
   PhotoApp — lógica principal
   ========================================================= */
(function () {
  'use strict';

  // ---------- Constantes ----------
  const STORAGE_KEY = 'photoapp.photos.v1';
  const MAX_WIDTH = 1000;         // largura máxima após captura
  const JPEG_QUALITY = 0.7;       // 0..1 — mais baixo = menor arquivo

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

  // ---------- Persistência ----------
  function loadPhotos() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn('Falha ao ler LocalStorage, começando vazio.', e);
      return [];
    }
  }

  function savePhotos(photos) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(photos));
      return true;
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.code === 22) {
        alert('⚠️ LocalStorage cheio! Exporte o backup e apague fotos antigas.');
      } else {
        alert('Erro ao salvar: ' + e.message);
      }
      return false;
    }
  }

  // ---------- Utilidades de data ----------
  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtDateTime(iso) {
    const d = new Date(iso);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function toISODateLocal(d) {
    // 'YYYY-MM-DD' no fuso local
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    video.srcObject = null;
    btnCapture.disabled = true;
    btnStop.disabled = true;
    btnStart.disabled = false;
    camStatus.textContent = 'Câmera parada.';
  }

  function capturePhoto() {
    if (!stream) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      alert('Vídeo ainda não pronto. Tente novamente.');
      return;
    }

    // Redimensiona mantendo proporção
    const scale = Math.min(1, MAX_WIDTH / vw);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h);

    // Marca d'água com data/hora
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

    // Fundo semi-transparente
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, h - boxH, boxW, boxH);

    // Texto
    ctx.fillStyle = '#ffffff';
    ctx.fillText(stamp, padding, h - padding);

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const photos = loadPhotos();
    const newPhoto = {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
      dataUrl,
      timestamp: now.toISOString(),
      order: photos.length,
    };
    photos.push(newPhoto);
    if (savePhotos(photos)) {
      renderGallery();
      // Pequeno flash de feedback
      video.style.filter = 'brightness(2)';
      setTimeout(() => (video.style.filter = ''), 120);
    }
  }

  // ---------- Renderização ----------
  function getFilteredPhotos() {
    const from = filterFrom.value ? new Date(filterFrom.value + 'T00:00:00') : null;
    const to   = filterTo.value   ? new Date(filterTo.value   + 'T23:59:59') : null;

    return loadPhotos()
      .filter(p => {
        const t = new Date(p.timestamp);
        if (from && t < from) return false;
        if (to && t > to) return false;
        return true;
      })
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  function renderGallery() {
    const photos = getFilteredPhotos();
    gallery.innerHTML = '';
    emptyMsg.style.display = photos.length ? 'none' : 'block';

    photos.forEach((p, idx) => {
      const card = document.createElement('div');
      card.className = 'photo-card';
      card.dataset.id = p.id;

      const img = document.createElement('img');
      img.src = p.dataUrl;
      img.alt = 'Foto ' + (idx + 1);
      img.loading = 'lazy';
      img.addEventListener('click', () => openModal(p));

      const meta = document.createElement('div');
      meta.className = 'photo-meta';
      meta.textContent = fmtDateTime(p.timestamp);

      const del = document.createElement('button');
      del.className = 'photo-del';
      del.title = 'Apagar foto';
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Apagar esta foto?')) deletePhoto(p.id);
      });

      card.append(img, meta, del);
      gallery.appendChild(card);
    });

    // Atualiza Sortable (reconstrói para refletir filtro)
    if (sortable) sortable.destroy();
    sortable = Sortable.create(gallery, {
      animation: 180,
      ghostClass: 'sortable-ghost',
      onEnd: (evt) => {
        // Reordena apenas entre as fotos visíveis (filtradas)
        const visibleIds = Array.from(gallery.children).map(c => c.dataset.id);
        const all = loadPhotos();

        // Recria a ordem global: as visíveis seguem a nova ordem,
        // as não visíveis mantêm posição relativa nas "lacunas".
        const visibleSet = new Set(visibleIds);
        const positions = [];
        all.forEach((p, i) => { if (visibleSet.has(p.id)) positions.push(i); });

        // Mapeia visíveis -> novas posições ordenadas
        const idToNewPos = {};
        visibleIds.forEach((id, i) => { idToNewPos[id] = positions[i]; });

        const reordered = [...all];
        visibleIds.forEach((id, i) => {
          const photo = all.find(p => p.id === id);
          reordered[positions[i]] = photo;
        });
        reordered.forEach((p, i) => { p.order = i; });

        savePhotos(reordered);
        updateStats();
      },
    });

    updateStats();
  }

  function updateStats() {
    const all = loadPhotos();
    const filtered = getFilteredPhotos();
    const shown = filtered.length;
    const total = all.length;
    stats.textContent = `📊 ${shown} de ${total} foto(s) exibida(s).`;
  }

  function deletePhoto(id) {
    const photos = loadPhotos().filter(p => p.id !== id);
    photos.forEach((p, i) => { p.order = i; });
    savePhotos(photos);
    renderGallery();
  }

  // ---------- Modal ----------
  function openModal(photo) {
    modalImg.src = photo.dataUrl;
    modalMeta.textContent = '📅 ' + fmtDateTime(photo.timestamp);
    modal.classList.remove('hidden');
  }
  function closeModal() {
    modal.classList.add('hidden');
    modalImg.src = '';
  }

  // ---------- Backup / Import ----------
  function exportBackup() {
    const photos = loadPhotos();
    if (!photos.length) {
      alert('Nada para exportar.');
      return;
    }
    const payload = {
      app: 'PhotoApp',
      version: 1,
      exportedAt: new Date().toISOString(),
      photos,
    };
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
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const incoming = Array.isArray(data) ? data : data.photos;
        if (!Array.isArray(incoming)) throw new Error('Formato inválido (esperado {photos: [...]}).');

        // Valida cada item
        const valid = incoming.filter(p => p && typeof p.dataUrl === 'string' && p.dataUrl.startsWith('data:image/'));
        if (!valid.length) throw new Error('Nenhuma foto válida encontrada.');

        const mode = confirm(
          `Importar ${valid.length} foto(s).\n\nOK = MESCLAR com as existentes.\nCancelar = SUBSTITUIR tudo.`
        );

        let result;
        if (mode) {
          const existing = loadPhotos();
          const existingIds = new Set(existing.map(p => p.id));
          result = [...existing, ...valid.filter(p => !existingIds.has(p.id))];
        } else {
          result = valid;
        }
        result.forEach((p, i) => { p.order = i; });

        if (savePhotos(result)) {
          renderGallery();
          alert(`✅ Importação concluída. Total agora: ${result.length} foto(s).`);
        }
      } catch (err) {
        console.error(err);
        alert('❌ Falha ao importar: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  async function sendBackupToServer() {
    const photos = loadPhotos();
    if (!photos.length) { alert('Nada para enviar.'); return; }
    try {
      const res = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Erro desconhecido');
      alert(`☁️ Backup salvo no servidor: ${json.file} (${json.count} fotos)`);
    } catch (err) {
      alert('❌ Falha ao enviar ao servidor: ' + err.message);
    }
  }

  // ---------- Eventos ----------
  btnStart.addEventListener('click', startCamera);
  btnCapture.addEventListener('click', capturePhoto);
  btnStop.addEventListener('click', stopCamera);
  btnExport.addEventListener('click', exportBackup);
  btnServerBk.addEventListener('click', sendBackupToServer);
  btnClearFil.addEventListener('click', () => {
    filterFrom.value = '';
    filterTo.value = '';
    renderGallery();
  });
  filterFrom.addEventListener('change', renderGallery);
  filterTo.addEventListener('change', renderGallery);

  importFile.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importBackup(f);
    e.target.value = ''; // permite reimportar o mesmo arquivo
  });

  btnClearAll.addEventListener('click', () => {
    if (confirm('Apagar TODAS as fotos? Isso não pode ser desfeito.')) {
      localStorage.removeItem(STORAGE_KEY);
      renderGallery();
    }
  });

  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // ---------- Init ----------
  renderGallery();
})();