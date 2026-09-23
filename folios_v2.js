/*
 * folios.js — Halloween 2026
 * Módulo offline de folios para navegador. Sin librerías y sin conexión obligatoria.
 *
 * Contrato congelado (ChatGPT + Cloud, 22-sep-2026):
 * - API global: Folios
 * - Folios.init() debe esperarse antes de usar el módulo.
 * - Todas las operaciones públicas son asíncronas y devuelven Promise.
 * - IndexedDB es la autoridad local; cada operación es atómica.
 * - Códigos: prefijo configurable + 6 caracteres de 234679CDFGHJKMNPQRTVWXY.
 * - Estados: impresa -> entregada -> canjeada; anulada es estado aparte.
 * - Cero datos personales.
 */

(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const DB_VERSION = 2;
  const DEFAULT_DB_NAME = 'folios_HW2026';
  const STORE_FOLIOS = 'folios';
  const STORE_META = 'meta';
  const STORE_VENTAS = 'ventas';
  const ALPHABET = '234679CDFGHJKMNPQRTVWXY'; // 23 símbolos; sin vocales ni gemelas obvias.
  const CODE_LENGTH = 6;

  const STATE = Object.freeze({
    PRINTED: 'impresa',
    DELIVERED: 'entregada',
    REDEEMED: 'canjeada',
    VOID: 'anulada'
  });

  class FoliosError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'FoliosError';
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  let db = null;
  let currentConfig = {
    prefijo: 'HW',
    niveles: []
  };
  let systemStatus = {
    initialized: false,
    ok: false,
    dbName: DEFAULT_DB_NAME,
    error: null
  };

  function assertIndexedDB() {
    if (!root.indexedDB) {
      throw new FoliosError('IDB_UNAVAILABLE', 'IndexedDB no está disponible en este navegador.');
    }
  }

  function assertCrypto() {
    if (!root.crypto || typeof root.crypto.getRandomValues !== 'function') {
      throw new FoliosError('CRYPTO_UNAVAILABLE', 'El generador aleatorio seguro del navegador no está disponible.');
    }
  }

  function assertInit() {
    if (!db || !systemStatus.initialized || !systemStatus.ok) {
      throw new FoliosError('NOT_INITIALIZED', 'Folios.init() debe completarse antes de usar el módulo.');
    }
  }

  function reqAsPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }

  function txAsPromise(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  }

  function openDatabase(dbName) {
    return new Promise((resolve, reject) => {
      const request = root.indexedDB.open(dbName, DB_VERSION);

      request.onupgradeneeded = () => {
        const upgradeDb = request.result;

        if (!upgradeDb.objectStoreNames.contains(STORE_FOLIOS)) {
          const store = upgradeDb.createObjectStore(STORE_FOLIOS, { keyPath: 'codigo' });
          store.createIndex('lote', 'lote', { unique: false });
          store.createIndex('estado', 'estado', { unique: false });
          store.createIndex('nivel', 'nivel', { unique: false });
        }

        if (!upgradeDb.objectStoreNames.contains(STORE_META)) {
          upgradeDb.createObjectStore(STORE_META, { keyPath: 'key' });
        }

        if (!upgradeDb.objectStoreNames.contains(STORE_VENTAS)) {
          const ventas = upgradeDb.createObjectStore(STORE_VENTAS, { keyPath: 'ventaId' });
          ventas.createIndex('codigo', 'codigo', { unique: false });

          // Migración desde v1: reconstruye el índice global de ventas a partir
          // de los historiales existentes. Si una base vieja ya contiene la misma
          // venta en dos llaves, conserva la primera y deja que la auditoría de
          // integridad lo reporte al arrancar.
          if (upgradeDb.objectStoreNames.contains(STORE_FOLIOS)) {
            const folios = request.transaction.objectStore(STORE_FOLIOS);
            folios.openCursor().onsuccess = (ev) => {
              const cursor = ev.target.result;
              if (!cursor) return;
              const rec = cursor.value || {};
              for (const h of rec.historial || []) {
                if (!h || !h.ventaId) continue;
                const addReq = ventas.add({
                  ventaId: String(h.ventaId),
                  codigo: rec.codigo,
                  monto: Number(h.monto || 0),
                  tipo: h.tipo || 'migrada',
                  fecha: h.fecha || null,
                  seq: Number(h.seq || 0)
                });
                // Una base v1 defectuosa pudo repetir la misma venta. Durante la
                // migración conservamos la primera sin abortar toda la actualización.
                addReq.onerror = (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                };
              }
              cursor.continue();
            };
          }
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('No se pudo abrir IndexedDB'));
      request.onblocked = () => reject(new FoliosError('IDB_BLOCKED', 'La base está bloqueada por otra pestaña o versión.'));
    });
  }

  async function selfTest(storageDb) {
    const token = '__selftest__';
    const value = { key: token, value: 'ok', at: Date.now() };
    const tx = storageDb.transaction([STORE_META], 'readwrite');
    const store = tx.objectStore(STORE_META);

    store.put(value);
    const readReq = store.get(token);
    const read = await reqAsPromise(readReq);
    if (!read || read.value !== 'ok') {
      try { tx.abort(); } catch (_) {}
      throw new FoliosError('STORAGE_SELFTEST_FAILED', 'La autoprueba de almacenamiento no pudo leer lo que escribió.');
    }
    store.delete(token);
    await txAsPromise(tx);
  }

  function normalizePrefix(prefix) {
    const p = String(prefix ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!p || p.length > 8) {
      throw new FoliosError('BAD_PREFIX', 'El prefijo debe tener entre 1 y 8 caracteres alfanuméricos.');
    }
    return p;
  }

  function normalizeLevels(levels) {
    if (levels == null) return [];
    if (!Array.isArray(levels)) throw new FoliosError('BAD_LEVELS', 'niveles debe ser un arreglo.');

    const clean = levels.map((lvl, i) => {
      const min = Number(lvl.min ?? lvl.minimo ?? 0);
      const id = String(lvl.id ?? lvl.nombre ?? `nivel_${i + 1}`).trim();
      const nombre = String(lvl.nombre ?? lvl.id ?? `Nivel ${i + 1}`).trim();
      if (!Number.isFinite(min) || min < 0 || !id) {
        throw new FoliosError('BAD_LEVEL', 'Cada nivel requiere un mínimo numérico >= 0 y un id/nombre.');
      }
      return { ...lvl, min, id, nombre };
    });

    clean.sort((a, b) => a.min - b.min);
    return clean;
  }

  function computeLevel(acumulado) {
    let selected = null;
    for (const lvl of currentConfig.niveles) {
      if (acumulado >= lvl.min) selected = lvl;
      else break;
    }
    return selected ? selected.id : null;
  }

  function levelForRecord(rec) {
    if (!rec) return null;
    if ((rec.estado === STATE.REDEEMED || rec.estadoAntesAnular === STATE.REDEEMED) && rec.nivelCanjeado !== undefined && rec.nivelCanjeado !== null) {
      return rec.nivelCanjeado;
    }
    return computeLevel(Number(rec.acumulado || 0));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function clone(value) {
    if (typeof root.structuredClone === 'function') return root.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeCode(code) {
    return String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  }

  function secureIndex(maxExclusive) {
    assertCrypto();
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 256) {
      throw new FoliosError('BAD_RANDOM_RANGE', 'Rango aleatorio no soportado.');
    }
    const limit = Math.floor(256 / maxExclusive) * maxExclusive;
    const buf = new Uint8Array(1);
    do {
      root.crypto.getRandomValues(buf);
    } while (buf[0] >= limit);
    return buf[0] % maxExclusive;
  }

  function randomSuffix() {
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[secureIndex(ALPHABET.length)];
    return out;
  }

  function randomShort(len = 4) {
    let out = '';
    for (let i = 0; i < len; i++) out += ALPHABET[secureIndex(ALPHABET.length)];
    return out;
  }

  function makeCode(prefix) {
    return `${normalizePrefix(prefix)}-${randomSuffix()}`;
  }

  function makeBatchId() {
    return `L-${Date.now().toString(36).toUpperCase()}-${randomShort(4)}`;
  }

  function makeEvent(seq, tipo, extra = {}) {
    return {
      seq,
      fecha: nowIso(),
      tipo,
      monto: extra.monto ?? null,
      ventaId: extra.ventaId ?? null,
      motivo: extra.motivo ?? null
    };
  }

  async function loadConfigFromDb() {
    const tx = db.transaction([STORE_META], 'readonly');
    const store = tx.objectStore(STORE_META);
    const rec = await reqAsPromise(store.get('config'));
    await txAsPromise(tx);
    if (rec && rec.value) {
      currentConfig = {
        prefijo: normalizePrefix(rec.value.prefijo || currentConfig.prefijo),
        niveles: normalizeLevels(rec.value.niveles || [])
      };
      return true;
    }
    return false;
  }

  async function saveConfigToDb(config) {
    const tx = db.transaction([STORE_META], 'readwrite');
    tx.objectStore(STORE_META).put({ key: 'config', value: clone(config) });
    await txAsPromise(tx);
  }

  async function init(options = {}) {
    if (db) {
      try { db.close(); } catch (_) {}
      db = null;
    }

    systemStatus = {
      initialized: false,
      ok: false,
      dbName: options.dbName || DEFAULT_DB_NAME,
      error: null
    };

    try {
      assertIndexedDB();
      assertCrypto();
      db = await openDatabase(systemStatus.dbName);
      await selfTest(db);

      const loaded = await loadConfigFromDb();
      const hasExplicitConfig = options.prefijo !== undefined || options.niveles !== undefined;
      if (hasExplicitConfig || !loaded) {
        currentConfig = {
          prefijo: normalizePrefix(options.prefijo ?? currentConfig.prefijo ?? 'HW'),
          niveles: normalizeLevels(options.niveles ?? currentConfig.niveles ?? [])
        };
        await saveConfigToDb(currentConfig);
      }

      // Asegura que exista el contador seq.
      {
        const tx = db.transaction([STORE_META], 'readwrite');
        const store = tx.objectStore(STORE_META);
        const rec = await reqAsPromise(store.get('seq'));
        if (!rec) store.put({ key: 'seq', value: 0 });
        await txAsPromise(tx);
      }

      systemStatus.initialized = true;
      systemStatus.ok = true;
      return clone(systemStatus);
    } catch (err) {
      systemStatus.initialized = true;
      systemStatus.ok = false;
      systemStatus.error = {
        code: err.code || 'INIT_FAILED',
        message: err.message || String(err)
      };
      if (db) {
        try { db.close(); } catch (_) {}
        db = null;
      }
      throw err;
    }
  }

  async function configurar({ prefijo, niveles } = {}) {
    assertInit();
    const next = {
      prefijo: normalizePrefix(prefijo ?? currentConfig.prefijo),
      niveles: normalizeLevels(niveles ?? currentConfig.niveles)
    };
    currentConfig = next;
    await saveConfigToDb(next);
    return clone(next);
  }

  async function generarLote(n, prefijo = currentConfig.prefijo, lote) {
    assertInit();
    n = Number(n);
    if (!Number.isInteger(n) || n <= 0 || n > 100000) {
      throw new FoliosError('BAD_BATCH_SIZE', 'n debe ser un entero entre 1 y 100000.');
    }

    const prefix = normalizePrefix(prefijo);
    const batchId = String(lote || makeBatchId());

    // Cargamos claves existentes antes de generar. El escritor único evita carreras entre terminales.
    const rtx = db.transaction([STORE_FOLIOS], 'readonly');
    const existingKeys = await reqAsPromise(rtx.objectStore(STORE_FOLIOS).getAllKeys());
    await txAsPromise(rtx);
    const used = new Set(existingKeys.map(String));
    const newCodes = [];

    while (newCodes.length < n) {
      const code = makeCode(prefix);
      if (!used.has(code)) {
        used.add(code);
        newCodes.push(code);
      }
    }

    const tx = db.transaction([STORE_FOLIOS, STORE_META], 'readwrite');
    const folios = tx.objectStore(STORE_FOLIOS);
    const meta = tx.objectStore(STORE_META);
    const seqRec = await reqAsPromise(meta.get('seq'));
    let seq = Number(seqRec?.value || 0);
    const createdAt = nowIso();

    for (const code of newCodes) {
      seq += 1;
      const record = {
        codigo: code,
        prefijo: prefix,
        lote: batchId,
        estado: STATE.PRINTED,
        acumulado: 0,
        nivel: null, // compatibilidad: el nivel vivo se calcula desde acumulado + configuración
        nivelCanjeado: null,
        ventaIds: [],
        creadoEn: createdAt,
        entregadoEn: null,
        canjeadoEn: null,
        anuladoEn: null,
        estadoAntesAnular: null,
        historial: [makeEvent(seq, 'impresa')]
      };
      folios.add(record);
    }
    meta.put({ key: 'seq', value: seq });
    await txAsPromise(tx);

    return { lote: batchId, prefijo: prefix, cantidad: newCodes.length, codigos: newCodes };
  }

  async function validar(codigo) {
    assertInit();
    const code = normalizeCode(codigo);
    const tx = db.transaction([STORE_FOLIOS], 'readonly');
    const rec = await reqAsPromise(tx.objectStore(STORE_FOLIOS).get(code));
    await txAsPromise(tx);
    if (!rec) return { existe: false, codigo: code };
    return {
      existe: true,
      codigo: rec.codigo,
      estado: rec.estado,
      nivel: levelForRecord(rec),
      acumulado: rec.acumulado,
      lote: rec.lote,
      fechas: {
        creada: rec.creadoEn,
        entregada: rec.entregadoEn,
        canjeada: rec.canjeadoEn,
        anulada: rec.anuladoEn
      }
    };
  }

  async function mutateOne(codigo, mutator) {
    assertInit();
    const code = normalizeCode(codigo);
    const tx = db.transaction([STORE_FOLIOS, STORE_META, STORE_VENTAS], 'readwrite');
    const store = tx.objectStore(STORE_FOLIOS);
    const meta = tx.objectStore(STORE_META);
    const ventas = tx.objectStore(STORE_VENTAS);

    try {
      const rec = await reqAsPromise(store.get(code));
      if (!rec) throw new FoliosError('NOT_FOUND', `El folio ${code} no existe.`);

      const seqRec = await reqAsPromise(meta.get('seq'));
      let seq = Number(seqRec?.value || 0);
      const nextSeq = () => ++seq;

      const result = await mutator(rec, nextSeq, ventas);
      if (result && result.noChange) {
        try { tx.abort(); } catch (_) {}
        return result.value;
      }

      store.put(rec);
      meta.put({ key: 'seq', value: seq });
      await txAsPromise(tx);
      return result?.value ?? clone(rec);
    } catch (err) {
      try { tx.abort(); } catch (_) {}
      throw err;
    }
  }

  async function entregar(codigo, monto = 0, ventaId = null) {
    monto = Number(monto || 0);
    if (!Number.isFinite(monto) || monto < 0) throw new FoliosError('BAD_AMOUNT', 'monto debe ser >= 0.');
    if (monto > 0 && !ventaId) throw new FoliosError('VENTA_ID_REQUIRED', 'ventaId es obligatorio cuando entregar suma un monto.');
    const saleId = ventaId == null ? null : String(ventaId);

    return mutateOne(codigo, async (rec, nextSeq, ventas) => {
      // La ventaId es global: una venta solo puede acreditar una llave.
      if (saleId) {
        const usada = await reqAsPromise(ventas.get(saleId));
        if (usada) {
          const same = usada.codigo === rec.codigo;
          return {
            noChange: true,
            value: {
              ok: same,
              duplicada: true,
              usadaEnOtroFolio: !same,
              codigo: rec.codigo,
              codigoOriginal: same ? rec.codigo : usada.codigo,
              acumulado: rec.acumulado,
              nivel: levelForRecord(rec)
            }
          };
        }
      }

      if (rec.estado !== STATE.PRINTED) {
        throw new FoliosError('BAD_STATE', `Solo una llave impresa puede entregarse; estado actual: ${rec.estado}.`);
      }

      rec.estado = STATE.DELIVERED;
      rec.entregadoEn = nowIso();
      if (monto > 0) rec.acumulado += monto;
      if (saleId && !rec.ventaIds.includes(saleId)) rec.ventaIds.push(saleId);

      const seq = nextSeq();
      const ev = makeEvent(seq, 'entregada', { monto, ventaId: saleId });
      rec.historial.push(ev);
      if (saleId) {
        ventas.add({ ventaId: saleId, codigo: rec.codigo, monto, tipo: 'entregada', fecha: ev.fecha, seq });
      }

      const nivel = computeLevel(rec.acumulado);
      return { value: { ok: true, duplicada: false, codigo: rec.codigo, acumulado: rec.acumulado, nivel, estado: rec.estado } };
    });
  }

  async function acumular(codigo, monto, ventaId) {
    monto = Number(monto);
    if (!Number.isFinite(monto) || monto <= 0) throw new FoliosError('BAD_AMOUNT', 'monto debe ser un número mayor que 0.');
    if (!ventaId) throw new FoliosError('VENTA_ID_REQUIRED', 'ventaId es obligatorio para acumular.');
    const saleId = String(ventaId);

    return mutateOne(codigo, async (rec, nextSeq, ventas) => {
      const usada = await reqAsPromise(ventas.get(saleId));
      if (usada) {
        const same = usada.codigo === rec.codigo;
        return {
          noChange: true,
          value: {
            ok: same,
            duplicada: true,
            usadaEnOtroFolio: !same,
            codigo: rec.codigo,
            codigoOriginal: same ? rec.codigo : usada.codigo,
            acumulado: rec.acumulado,
            nivel: levelForRecord(rec)
          }
        };
      }

      if (rec.estado !== STATE.DELIVERED) {
        throw new FoliosError('BAD_STATE', `Solo una llave entregada puede acumular; estado actual: ${rec.estado}.`);
      }

      rec.acumulado += monto;
      if (!rec.ventaIds.includes(saleId)) rec.ventaIds.push(saleId);
      const seq = nextSeq();
      const ev = makeEvent(seq, 'acumulada', { monto, ventaId: saleId });
      rec.historial.push(ev);
      ventas.add({ ventaId: saleId, codigo: rec.codigo, monto, tipo: 'acumulada', fecha: ev.fecha, seq });

      const nivel = computeLevel(rec.acumulado);
      return { value: { ok: true, duplicada: false, codigo: rec.codigo, acumulado: rec.acumulado, nivel, estado: rec.estado } };
    });
  }

  async function canjear(codigo) {
    return mutateOne(codigo, async (rec, nextSeq) => {
      if (rec.estado === STATE.REDEEMED) {
        return { noChange: true, value: { ok: false, yaCanjeada: true, codigo: rec.codigo, nivel: levelForRecord(rec), acumulado: rec.acumulado } };
      }
      if (rec.estado !== STATE.DELIVERED) {
        throw new FoliosError('BAD_STATE', `Solo una llave entregada puede canjearse; estado actual: ${rec.estado}.`);
      }
      const nivel = computeLevel(rec.acumulado);
      rec.nivelCanjeado = nivel;
      rec.nivel = nivel; // compatibilidad con respaldos v1; queda congelado solo al canjear.
      rec.estado = STATE.REDEEMED;
      rec.canjeadoEn = nowIso();
      rec.historial.push(makeEvent(nextSeq(), 'canjeada'));
      return { value: { ok: true, yaCanjeada: false, codigo: rec.codigo, nivel, acumulado: rec.acumulado, estado: rec.estado } };
    });
  }

  async function anular(target, motivo) {
    assertInit();
    const why = String(motivo ?? '').trim();
    if (!why) throw new FoliosError('VOID_REASON_REQUIRED', 'Anular requiere un motivo.');

    let codigo = null;
    let lote = null;
    if (typeof target === 'string') {
      codigo = normalizeCode(target);
    } else if (target && typeof target === 'object') {
      if (target.codigo) codigo = normalizeCode(target.codigo);
      if (target.lote) lote = String(target.lote);
    }
    if (!codigo && !lote) throw new FoliosError('BAD_VOID_TARGET', 'Indica codigo o lote para anular.');

    // Si target fue string, primero intentamos tratarlo como código; si no existe, como lote.
    if (codigo && !lote) {
      const check = await validar(codigo);
      if (!check.existe && typeof target === 'string') {
        lote = String(target);
        codigo = null;
      }
    }

    if (codigo) {
      return mutateOne(codigo, async (rec, nextSeq) => {
        if (rec.estado === STATE.VOID) {
          return { noChange: true, value: { ok: true, yaAnulada: true, codigo: rec.codigo } };
        }
        rec.estadoAntesAnular = rec.estado;
        rec.estado = STATE.VOID;
        rec.anuladoEn = nowIso();
        rec.historial.push(makeEvent(nextSeq(), 'anulada', { motivo: why }));
        return { value: { ok: true, yaAnulada: false, codigo: rec.codigo, estado: rec.estado } };
      });
    }

    // Anulación de lote: una sola transacción para todos los registros del lote.
    const tx = db.transaction([STORE_FOLIOS, STORE_META], 'readwrite');
    const store = tx.objectStore(STORE_FOLIOS);
    const meta = tx.objectStore(STORE_META);
    try {
      const recs = await reqAsPromise(store.index('lote').getAll(lote));
      if (!recs.length) throw new FoliosError('BATCH_NOT_FOUND', `No existe el lote ${lote}.`);
      const seqRec = await reqAsPromise(meta.get('seq'));
      let seq = Number(seqRec?.value || 0);
      let changed = 0;
      for (const rec of recs) {
        if (rec.estado === STATE.VOID) continue;
        rec.estadoAntesAnular = rec.estado;
        rec.estado = STATE.VOID;
        rec.anuladoEn = nowIso();
        rec.historial.push(makeEvent(++seq, 'anulada', { motivo: why }));
        store.put(rec);
        changed += 1;
      }
      meta.put({ key: 'seq', value: seq });
      await txAsPromise(tx);
      return { ok: true, lote, anuladas: changed, total: recs.length };
    } catch (err) {
      try { tx.abort(); } catch (_) {}
      throw err;
    }
  }

  async function corregirAnulacion(codigo, motivo) {
    const why = String(motivo ?? '').trim();
    if (!why) throw new FoliosError('CORRECTION_REASON_REQUIRED', 'La corrección administrativa requiere un motivo.');

    return mutateOne(codigo, async (rec, nextSeq) => {
      if (rec.estado !== STATE.VOID || !rec.estadoAntesAnular) {
        throw new FoliosError('NOT_VOID', 'El folio no está anulado o no tiene estado previo recuperable.');
      }
      const restored = rec.estadoAntesAnular;
      rec.estado = restored;
      rec.estadoAntesAnular = null;
      rec.anuladoEn = null;
      rec.historial.push(makeEvent(nextSeq(), 'correccion_anulacion', { motivo: why }));
      return { value: { ok: true, codigo: rec.codigo, estado: rec.estado } };
    });
  }

  function salesFromFolios(rows) {
    const out = new Map();
    for (const rec of rows || []) {
      const seenInHistory = new Set();
      for (const ev of rec.historial || []) {
        if (!ev || !ev.ventaId) continue;
        const ventaId = String(ev.ventaId);
        const prev = out.get(ventaId);
        if (prev && prev.codigo !== rec.codigo) {
          throw new FoliosError('DUPLICATE_SALE_IN_DATA', `La venta ${ventaId} aparece en más de una llave.`, { ventaId, codigos: [prev.codigo, rec.codigo] });
        }
        if (!prev) {
          out.set(ventaId, {
            ventaId,
            codigo: rec.codigo,
            monto: Number(ev.monto || 0),
            tipo: ev.tipo || 'importada',
            fecha: ev.fecha || null,
            seq: Number(ev.seq || 0)
          });
        }
        seenInHistory.add(ventaId);
      }
      // Compatibilidad con respaldos viejos donde ventaIds existía aunque faltara el evento.
      for (const rawId of rec.ventaIds || []) {
        const ventaId = String(rawId);
        if (seenInHistory.has(ventaId)) continue;
        const prev = out.get(ventaId);
        if (prev && prev.codigo !== rec.codigo) {
          throw new FoliosError('DUPLICATE_SALE_IN_DATA', `La venta ${ventaId} aparece en más de una llave.`, { ventaId, codigos: [prev.codigo, rec.codigo] });
        }
        if (!prev) out.set(ventaId, { ventaId, codigo: rec.codigo, monto: 0, tipo: 'migrada', fecha: null, seq: 0 });
      }
    }
    return [...out.values()];
  }

  async function exportar() {
    assertInit();
    const tx = db.transaction([STORE_FOLIOS, STORE_META], 'readonly');
    const foliosStore = tx.objectStore(STORE_FOLIOS);
    const meta = tx.objectStore(STORE_META);
    const [folios, seqRec, configRec] = await Promise.all([
      reqAsPromise(foliosStore.getAll()),
      reqAsPromise(meta.get('seq')),
      reqAsPromise(meta.get('config'))
    ]);
    await txAsPromise(tx);

    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      seq: Number(seqRec?.value || 0),
      config: clone(configRec?.value || currentConfig),
      folios: clone(folios)
    };
  }

  function parseImport(input) {
    let data = input;
    if (typeof input === 'string') {
      try { data = JSON.parse(input); }
      catch (_) { throw new FoliosError('BAD_JSON', 'El respaldo no contiene JSON válido.'); }
    }
    if (!data || typeof data !== 'object') throw new FoliosError('BAD_BACKUP', 'Respaldo inválido.');
    if (Number(data.schemaVersion) !== SCHEMA_VERSION) {
      throw new FoliosError('SCHEMA_MISMATCH', `schemaVersion ${data.schemaVersion} no es compatible con ${SCHEMA_VERSION}.`);
    }
    if (!Array.isArray(data.folios)) throw new FoliosError('BAD_BACKUP', 'El respaldo no contiene un arreglo folios.');
    return data;
  }

  function sameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function historyIsPrefix(shorter, longer) {
    if (!Array.isArray(shorter) || !Array.isArray(longer) || shorter.length > longer.length) return false;
    for (let i = 0; i < shorter.length; i++) {
      if (!sameJson(shorter[i], longer[i])) return false;
    }
    return true;
  }

  async function analizarImportacion(input) {
    assertInit();
    const data = parseImport(input);
    const tx = db.transaction([STORE_FOLIOS], 'readonly');
    const local = await reqAsPromise(tx.objectStore(STORE_FOLIOS).getAll());
    await txAsPromise(tx);
    const localMap = new Map(local.map(x => [x.codigo, x]));

    let nuevos = 0;
    let cambios = 0;
    let iguales = 0;
    let localMasNuevo = 0;
    const conflictos = [];

    for (const incoming of data.folios) {
      const code = normalizeCode(incoming.codigo);
      const cur = localMap.get(code);
      if (!cur) {
        nuevos += 1;
        continue;
      }
      if (sameJson(cur, incoming)) {
        iguales += 1;
      } else if (historyIsPrefix(cur.historial, incoming.historial)) {
        cambios += 1; // respaldo más nuevo que local
      } else if (historyIsPrefix(incoming.historial, cur.historial)) {
        localMasNuevo += 1; // local ya tiene más historia; no se toca
      } else {
        conflictos.push(code);
      }
    }

    return {
      schemaVersion: data.schemaVersion,
      nuevos,
      cambios,
      iguales,
      localMasNuevo,
      conflictos: conflictos.length,
      codigosEnConflicto: conflictos
    };
  }

  async function aplicarImportacion(input, options = {}) {
    assertInit();
    if (options.confirmado !== true) {
      throw new FoliosError('IMPORT_NOT_CONFIRMED', 'La interfaz debe confirmar explícitamente antes de aplicar una importación.');
    }

    const data = parseImport(input);
    const analysis = await analizarImportacion(data);
    const resolution = options.resolverConflictos || null; // 'mantener_local' | 'usar_importado'
    if (analysis.conflictos > 0 && !['mantener_local', 'usar_importado'].includes(resolution)) {
      throw new FoliosError('IMPORT_CONFLICTS', 'Hay conflictos; indica resolverConflictos explícitamente.', analysis);
    }

    const tx = db.transaction([STORE_FOLIOS, STORE_META, STORE_VENTAS], 'readwrite');
    const store = tx.objectStore(STORE_FOLIOS);
    const meta = tx.objectStore(STORE_META);
    const ventas = tx.objectStore(STORE_VENTAS);
    try {
      const local = await reqAsPromise(store.getAll());
      const localMap = new Map(local.map(x => [x.codigo, x]));
      let applied = 0;

      for (const incoming of data.folios) {
        const code = normalizeCode(incoming.codigo);
        incoming.codigo = code;
        const cur = localMap.get(code);
        if (!cur) {
          store.put(clone(incoming));
          applied += 1;
          continue;
        }
        if (sameJson(cur, incoming)) continue;
        if (historyIsPrefix(cur.historial, incoming.historial)) {
          store.put(clone(incoming));
          applied += 1;
          continue;
        }
        if (historyIsPrefix(incoming.historial, cur.historial)) continue;
        if (resolution === 'usar_importado') {
          store.put(clone(incoming));
          applied += 1;
        }
      }

      const seqRec = await reqAsPromise(meta.get('seq'));
      const currentSeq = Number(seqRec?.value || 0);
      let maxImportedSeq = Number(data.seq || 0);
      for (const rec of data.folios) {
        for (const ev of rec.historial || []) maxImportedSeq = Math.max(maxImportedSeq, Number(ev.seq || 0));
      }
      meta.put({ key: 'seq', value: Math.max(currentSeq, maxImportedSeq) });

      // En una restauración sobre base vacía, recuperar también la configuración del respaldo.
      if (local.length === 0 && data.config) {
        const importedConfig = {
          prefijo: normalizePrefix(data.config.prefijo || currentConfig.prefijo),
          niveles: normalizeLevels(data.config.niveles || [])
        };
        currentConfig = importedConfig;
        meta.put({ key: 'config', value: clone(importedConfig) });
      } else if (options.aplicarConfig === true && data.config) {
        const importedConfig = {
          prefijo: normalizePrefix(data.config.prefijo || currentConfig.prefijo),
          niveles: normalizeLevels(data.config.niveles || [])
        };
        currentConfig = importedConfig;
        meta.put({ key: 'config', value: clone(importedConfig) });
      }


      // Reconstruye el índice global de ventaId desde la verdad histórica final.
      const finalFolios = await reqAsPromise(store.getAll());
      const finalSales = salesFromFolios(finalFolios);
      ventas.clear();
      for (const sale of finalSales) ventas.add(sale);

      await txAsPromise(tx);
      return { ok: true, aplicados: applied, analisis: analysis, siguienteSeq: Math.max(currentSeq, maxImportedSeq) + 1 };
    } catch (err) {
      try { tx.abort(); } catch (_) {}
      throw err;
    }
  }

  async function resumen() {
    assertInit();
    const tx = db.transaction([STORE_FOLIOS], 'readonly');
    const rows = await reqAsPromise(tx.objectStore(STORE_FOLIOS).getAll());
    await txAsPromise(tx);

    const porEstado = {};
    const porNivel = {};
    for (const rec of rows) {
      porEstado[rec.estado] = (porEstado[rec.estado] || 0) + 1;
      const lvl = levelForRecord(rec) || 'sin_nivel';
      porNivel[lvl] = (porNivel[lvl] || 0) + 1;
    }
    return { total: rows.length, porEstado, porNivel };
  }

  async function estadoSistema() {
    return clone({ ...systemStatus, config: currentConfig, schemaVersion: SCHEMA_VERSION });
  }

  const Folios = Object.freeze({
    init,
    configurar,
    generarLote,
    validar,
    entregar,
    acumular,
    canjear,
    anular,
    corregirAnulacion,
    exportar,
    analizarImportacion,
    aplicarImportacion,
    resumen,
    estadoSistema,
    constantes: Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      alfabeto: ALPHABET,
      longitudCodigo: CODE_LENGTH,
      estados: STATE
    })
  });

  root.Folios = Folios;
})(typeof globalThis !== 'undefined' ? globalThis : window);
