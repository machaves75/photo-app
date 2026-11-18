/* =========================================================
   db.js — Camada de persistência em IndexedDB
   ---------------------------------------------------------
   - Banco: "photoapp"
   - Store: "photos" (keyPath: "id")
   - Índices: "order" (para reordenar), "timestamp" (para filtro)
   - Guarda a foto como Blob + thumbnail como Blob (opcional)
   ========================================================= */
(function (global) {
  'use strict';

  const DB_NAME = 'photoapp';
  const DB_VERSION = 2;              // v2: nova era (IndexedDB)
  const STORE = 'photos';
  const LEGACY_LS_KEY = 'photoapp.photos.v1';

  let dbPromise = null;

  // ---------- Abrir banco ----------
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (evt) => {
        const db = evt.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('order', 'order', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn('IndexedDB bloqueado (outra aba?)');
    });
    return dbPromise;
  }

  // ---------- Helpers de transação ----------
  async function tx(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let result;
      try {
        result = fn(store);
      } catch (err) {
        reject(err);
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Transação abortada'));
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------- API pública ----------
  const DB = {
    /**
     * Adiciona uma foto (Blob) com metadados.
     * Retorna o id gerado.
     */
    async addPhoto({ blob, timestamp }) {
      const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
      await tx('readwrite', (store) => {
        // Calcula próximo order dentro da transação
        const orderReq = store.index('order').openCursor(null, 'prev');
        orderReq.onsuccess = () => {
          const cursor = orderReq.result;
          const nextOrder = cursor ? (cursor.value.order ?? 0) + 1 : 0;
          store.add({
            id,
            blob,
            timestamp: timestamp || new Date().toISOString(),
            order: nextOrder,
          });
        };
      });
      return id;
    },

    /** Retorna todas as fotos ordenadas por "order" (asc). */
    async getAll() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const idx = t.objectStore(STORE).index('order');
        const req = idx.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },

    /** Filtra por intervalo de datas [from, to] (Date ou null). */
    async getByDateRange(from, to) {
      const all = await this.getAll();
      return all.filter(p => {
        const t = new Date(p.timestamp);
        if (from && t < from) return false;
        if (to && t > to) return false;
        return true;
      });
    },

    /** Atualiza o campo "order" de cada foto conforme o array de ids. */
    async reorderByIds(orderedIds) {
      if (!orderedIds.length) return;
      await tx('readwrite', (store) => {
        orderedIds.forEach((id, i) => {
          const getReq = store.get(id);
          getReq.onsuccess = () => {
            const obj = getReq.result;
            if (obj) {
              obj.order = i;
              store.put(obj);
            }
          };
        });
      });
    },

    /** Deleta uma foto pelo id. */
    async deletePhoto(id) {
      await tx('readwrite', (store) => store.delete(id));
    },

    /** Limpa tudo (usado no "apagar tudo"). */
    async clearAll() {
      await tx('readwrite', (store) => store.clear());
    },

    /** Substitui o conteúdo inteiro (usado na importação "substituir"). */
    async replaceAll(photos) {
      await tx('readwrite', (store) => {
        store.clear();
        photos.forEach((p, i) => {
          store.add({ ...p, order: i });
        });
      });
    },

    /**
     * Importa fotos mesclando por id (ignora ids já existentes).
     * Retorna quantidade adicionada.
     */
    async mergePhotos(photos) {
      const existing = await this.getAll();
      const existingIds = new Set(existing.map(p => p.id));
      const toAdd = photos.filter(p => !existingIds.has(p.id));
      if (!toAdd.length) return 0;
      const baseOrder = existing.length;
      await tx('readwrite', (store) => {
        toAdd.forEach((p, i) => {
          store.add({ ...p, order: baseOrder + i });
        });
      });
      return toAdd.length;
    },

    /** Contagem total (usada no "stats"). */
    async count() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    /**
     * Migração opcional: lê LocalStorage antigo (Base64) e
     * converte cada dataUrl em Blob, movendo para o IndexedDB.
     * Depois remove a chave antiga. Idempotente.
     */
    async migrateFromLocalStorage() {
      const raw = localStorage.getItem(LEGACY_LS_KEY);
      if (!raw) return { migrated: 0 };

      let arr = [];
      try { arr = JSON.parse(raw); } catch { arr = []; }
      if (!Array.isArray(arr) || !arr.length) {
        localStorage.removeItem(LEGACY_LS_KEY);
        return { migrated: 0 };
      }

      const photos = [];
      for (const p of arr) {
        if (!p || typeof p.dataUrl !== 'string') continue;
        const blob = dataUrlToBlob(p.dataUrl);
        if (!blob) continue;
        photos.push({
          id: p.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
          blob,
          timestamp: p.timestamp || new Date().toISOString(),
        });
      }
      if (photos.length) await this.replaceAll(photos);
      localStorage.removeItem(LEGACY_LS_KEY);
      return { migrated: photos.length };
    },

    /** Utilidades de exportação */
    async exportToJSON() {
      const all = await this.getAll();
      const out = [];
      for (const p of all) {
        out.push({
          id: p.id,
          timestamp: p.timestamp,
          order: p.order,
          dataUrl: await blobToDataUrl(p.blob), // Base64 no export (compatível com backup antigo)
        });
      }
      return {
        app: 'PhotoApp',
        version: 2,
        storage: 'indexeddb',
        exportedAt: new Date().toISOString(),
        photos: out,
      };
    },

    /** Converte payload de backup (Base64 ou Blob-json) para estrutura interna. */
    async importFromPayload(payload) {
      const raw = Array.isArray(payload) ? payload : payload.photos;
      if (!Array.isArray(raw)) throw new Error('Backup inválido: esperado { photos: [...] }.');
      const photos = [];
      for (const p of raw) {
        if (!p) continue;
        let blob = null;
        if (typeof p.dataUrl === 'string' && p.dataUrl.startsWith('data:image/')) {
          blob = dataUrlToBlob(p.dataUrl);
        }
        if (!blob) continue;
        photos.push({
          id: p.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
          blob,
          timestamp: p.timestamp || new Date().toISOString(),
        });
      }
      return photos;
    },
  };

  // ---------- Utilitários ----------
  function dataUrlToBlob(dataUrl) {
    try {
      const [header, b64] = dataUrl.split(',');
      const mime = /data:([^;]+);/.exec(header)?.[1] || 'image/jpeg';
      const bin = atob(b64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    } catch (err) {
      console.warn('dataUrlToBlob falhou', err);
      return null;
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // Estima uso atual da cota (útil para mostrar no stats)
  DB.estimateUsage = async function () {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try { return await navigator.storage.estimate(); }
    catch { return null; }
  };

  DB.LS_KEY = LEGACY_LS_KEY;
  global.PhotoDB = DB;
})(window);
