/*
 * halloween.js — Halloween 2026
 * Capa de temporada para el ERP de ventas.
 * - Folios (folios_v2.js) sigue siendo la autoridad para Jack: estado, acumulado, nivel y canje.
 * - Esta base separada guarda cartas, inventario, repartos, eventos y estadísticas.
 * - No exige datos personales. Cada Jack puede tener una nota/nombre/recordatorio opcional.
 */
(function(root){
  'use strict';

  const APP_VERSION = '0.4.8';
  const DB_NAME = 'halloween_2026';
  const DB_VERSION = 2;
  const STORES = Object.freeze({
    META:'meta', PROFILES:'profiles', SALES:'sales', EVENTS:'events', INVENTORY:'inventory', OPS:'ops', PENDING:'pending_no_jack'
  });

  const LEVELS = Object.freeze([
    { id:'N1', nombre:'Nivel 1', min:50 },
    { id:'N2', nombre:'Nivel 2', min:100 },
    { id:'N3', nombre:'Nivel 3', min:150 },
    { id:'N4', nombre:'Nivel 4', min:300 }
  ]);

  // 17 cartas normales. Los IDs son internos y estables; el nombre/número visible se puede ajustar después.
  // Proporción objetivo física por diseño: 3 copias de cada común, 2 de cada rara, 1 de cada épica.
  const DEFAULT_CARDS = Object.freeze([
    { id:'C1', nombre:'Esqueleto', rareza:'comun', peso:3 },
    { id:'C2', nombre:'Fantasma', rareza:'comun', peso:3 },
    { id:'C3', nombre:'Bruja', rareza:'comun', peso:3 },
    { id:'C4', nombre:'Drácula', rareza:'comun', peso:3 },
    { id:'C5', nombre:'Hombre Lobo', rareza:'comun', peso:3 },
    { id:'C6', nombre:'Zombi', rareza:'comun', peso:3 },
    { id:'C7', nombre:'Criatura', rareza:'comun', peso:3 },
    { id:'R1', nombre:'Momia', rareza:'rara', peso:2 },
    { id:'R2', nombre:'Payaso Siniestro', rareza:'rara', peso:2 },
    { id:'R3', nombre:'Chupacabras', rareza:'rara', peso:2 },
    { id:'R4', nombre:'Wendigo', rareza:'rara', peso:2 },
    { id:'R5', nombre:'Jiangshi', rareza:'rara', peso:2 },
    { id:'R6', nombre:'Alien', rareza:'rara', peso:2 },
    { id:'E1', nombre:'La Llorona', rareza:'epica', peso:1 },
    { id:'E2', nombre:'Nahual', rareza:'epica', peso:1 },
    { id:'E3', nombre:'Krampus', rareza:'epica', peso:1 },
    { id:'E4', nombre:'Oni', rareza:'epica', peso:1 }
  ]);

  const DEFAULT_CONFIG = Object.freeze({
    enabled:true,
    prefijo:'H26',
    cartaCada:25,
    compraMinJack:50,
    strictInventory:false,
    rescateActivo:false,
    rescatePrecio:8,
    rescateMax:5,
    rescateDesde:'2026-10-25'
  });

  let db = null;
  let config = {...DEFAULT_CONFIG};
  let writerLock = { owned:false, id:null, timer:null };

  function nowIso(){ return new Date().toISOString(); }
  function clone(v){ return root.structuredClone ? root.structuredClone(v) : JSON.parse(JSON.stringify(v)); }
  function normalizeCode(v){ return String(v || '').trim().toUpperCase().replace(/\s+/g,''); }
  function money(n){ return '$' + (Number(n)||0).toFixed(2); }
  function txPromise(tx){ return new Promise((res,rej)=>{ tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error||new Error('IndexedDB')); tx.onabort=()=>rej(tx.error||new Error('IndexedDB abortada')); }); }
  function reqPromise(req){ return new Promise((res,rej)=>{ req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error||new Error('IndexedDB request')); }); }
  function uuid(){
    if(root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    const a = new Uint8Array(16); root.crypto.getRandomValues(a); a[6]=(a[6]&15)|64; a[8]=(a[8]&63)|128;
    const h=[...a].map(x=>x.toString(16).padStart(2,'0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }
  function sanitizeItems(items){
    return (Array.isArray(items)?items:[]).map(x=>({
      nombre:String(x?.nombre||'').trim(), cantidad:Number(x?.cantidad)||0, precio:Number(x?.precio)||0,
      total:Number(x?.total)||0, canal:String(x?.canal||''), fecha:String(x?.fecha||''), vendedor:String(x?.socio||x?.vendedor||'')
    })).filter(x=>x.nombre);
  }

  function openDb(){
    return new Promise((resolve,reject)=>{
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = ()=>{
        const d = r.result;
        if(!d.objectStoreNames.contains(STORES.META)) d.createObjectStore(STORES.META,{keyPath:'key'});
        if(!d.objectStoreNames.contains(STORES.PROFILES)) d.createObjectStore(STORES.PROFILES,{keyPath:'codigo'});
        if(!d.objectStoreNames.contains(STORES.SALES)){
          const s=d.createObjectStore(STORES.SALES,{keyPath:'ventaId'});
          s.createIndex('fecha','fecha',{unique:false});
        }
        if(!d.objectStoreNames.contains(STORES.EVENTS)){
          const e=d.createObjectStore(STORES.EVENTS,{keyPath:'id'});
          e.createIndex('codigo','codigo',{unique:false});
          e.createIndex('ventaId','ventaId',{unique:false});
          e.createIndex('fecha','fecha',{unique:false});
          e.createIndex('tipo','tipo',{unique:false});
        }
        if(!d.objectStoreNames.contains(STORES.INVENTORY)) d.createObjectStore(STORES.INVENTORY,{keyPath:'id'});
        if(!d.objectStoreNames.contains(STORES.OPS)) d.createObjectStore(STORES.OPS,{keyPath:'id'});
        if(!d.objectStoreNames.contains(STORES.PENDING)) d.createObjectStore(STORES.PENDING,{keyPath:'id'});
      };
      r.onsuccess=()=>resolve(r.result);
      r.onerror=()=>reject(r.error||new Error('No se pudo abrir Halloween DB'));
    });
  }

  async function metaGet(key, fallback=null){
    const tx=db.transaction([STORES.META],'readonly');
    const v=await reqPromise(tx.objectStore(STORES.META).get(key)); await txPromise(tx);
    return v ? v.value : fallback;
  }
  async function metaSet(key,value){
    const tx=db.transaction([STORES.META],'readwrite'); tx.objectStore(STORES.META).put({key,value:clone(value)}); await txPromise(tx);
  }

  async function ensureInventory(){
    const tx=db.transaction([STORES.INVENTORY],'readwrite');
    const st=tx.objectStore(STORES.INVENTORY);
    for(const c of DEFAULT_CARDS){
      const old=await reqPromise(st.get(c.id));
      if(!old) st.put({...c, numero:null, stock:null, inicial:null, reservado:0, actualizadoEn:nowIso()});
    }
    await txPromise(tx);
  }

  async function initCore(){
    if(!root.indexedDB) throw new Error('IndexedDB no disponible');
    if(!root.crypto || !root.crypto.getRandomValues) throw new Error('Crypto no disponible');
    db=await openDb();
    config={...DEFAULT_CONFIG,...(await metaGet('config',{}))};
    await metaSet('config',config);
    await ensureInventory();
    await requestPersistence();
    return {ok:true,version:APP_VERSION,config:clone(config)};
  }

  async function requestPersistence(){
    try{
      if(navigator.storage && navigator.storage.persist){
        const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        const granted = already || await navigator.storage.persist();
        await metaSet('persisted',!!granted);
        return !!granted;
      }
    }catch(_){ }
    return false;
  }

  function getWriterTabId(){
    // Conserva la identidad al RECARGAR la misma pestaña, pero evita heredarla
    // normalmente al abrir/duplicar otra pestaña. Así un refresh no queda 12 s
    // bloqueado por su propio candado anterior.
    const key='hw2026_tab_id';
    let id=null;
    try{
      const nav=root.performance?.getEntriesByType?.('navigation')?.[0]?.type||'';
      id=sessionStorage.getItem(key);
      if(!id || nav!=='reload'){
        id=uuid();
        sessionStorage.setItem(key,id);
      }
    }catch(_){ id=writerLock.id||uuid(); }
    return id;
  }

  async function acquireWriterLock(options={}){
    // Bloqueo sencillo entre pestañas del mismo navegador. Es deliberadamente
    // recuperable: la misma pestaña puede recargar sin perder permiso y, si el
    // usuario lo decide, puede tomar control explícitamente desde la interfaz.
    const key='hw2026_writer_lock';
    const id=getWriterTabId();
    const ttl=12000;
    const now=Date.now();
    const force=!!options.force;
    let cur=null;
    try{ cur=JSON.parse(localStorage.getItem(key)||'null'); }catch(_){ }
    if(cur && cur.expires>now && cur.id!==id && !force){
      writerLock.owned=false; writerLock.id=id;
      return {ok:false,holder:cur.id,expires:cur.expires};
    }

    if(writerLock.timer){ clearInterval(writerLock.timer); writerLock.timer=null; }
    const write=()=>{
      try{
        const current=JSON.parse(localStorage.getItem(key)||'null');
        // Si otra pestaña tomó el control después, no se lo robamos de vuelta.
        if(current && current.expires>Date.now() && current.id!==id){
          writerLock.owned=false;
          if(writerLock.timer){ clearInterval(writerLock.timer); writerLock.timer=null; }
          return false;
        }
        localStorage.setItem(key,JSON.stringify({id,expires:Date.now()+ttl,version:APP_VERSION}));
        writerLock.owned=true; writerLock.id=id;
        return true;
      }catch(_){
        // Si localStorage falla, no bloqueamos todo Halloween por un candado
        // auxiliar; IndexedDB y los IDs de operación siguen protegiendo datos.
        writerLock.owned=true; writerLock.id=id;
        return true;
      }
    };
    // En toma de control explícita se reemplaza el candado actual una sola vez.
    if(force){
      try{ localStorage.setItem(key,JSON.stringify({id,expires:Date.now()+ttl,version:APP_VERSION})); }catch(_){}
      writerLock.owned=true; writerLock.id=id;
    }else write();
    writerLock.timer=setInterval(write,5000);
    const release=()=>{
      try{ const c=JSON.parse(localStorage.getItem(key)||'null'); if(c&&c.id===id)localStorage.removeItem(key); }catch(_){}
    };
    root.addEventListener('pagehide',release,{once:true});
    root.addEventListener('beforeunload',release,{once:true});
    return {ok:true,id,forced:force};
  }

  async function requireWriter(){
    if(writerLock.owned) return true;
    const lock=await acquireWriterLock();
    if(lock.ok) return true;
    throw new Error('Otra pestaña tiene el control de escritura Halloween. Cierra la otra pestaña o usa “Tomar control aquí” en la pantalla 🎃.');
  }

  async function getProfile(codigo, create=true){
    const code=normalizeCode(codigo); if(!code) return null;
    const tx=db.transaction([STORES.PROFILES],'readwrite'); const st=tx.objectStore(STORES.PROFILES);
    let p=await reqPromise(st.get(code));
    if(!p && create){
      p={ codigo:code, creadoEn:nowIso(), actualizadoEn:nowIso(), freeDelivered:0, cardHistory:[], rescates:0, catrina:false, charro:false, albumComplete:false, reportedOwned:[], reportedAt:null, nota:'' };
      st.add(p);
    }
    await txPromise(tx); return p?clone(p):null;
  }

  async function saveProfile(p){
    p.actualizadoEn=nowIso();
    const tx=db.transaction([STORES.PROFILES],'readwrite'); tx.objectStore(STORES.PROFILES).put(clone(p)); await txPromise(tx); return clone(p);
  }

  async function saveJackNote(codigo,nota=''){
    await requireWriter();
    const p=await getProfile(codigo,true);
    const clean=String(nota||'').trim().slice(0,500);
    const prev=String(p.nota||'');
    if(prev===clean) return p;
    p.nota=clean;
    const saved=await saveProfile(p);
    await addEvent({tipo:'jack_nota',codigo:saved.codigo,nota:clean});
    return saved;
  }

  async function registerPastJack({codigo,monto,fechaVenta,nota=''}){
    await requireWriter();
    const amount=Number(monto);
    if(!Number.isFinite(amount)||amount<=0) throw new Error('Monto inválido.');
    const code=normalizeCode(codigo); if(!code) throw new Error('Escribe el código Jack.');
    const val=await Folios.validar(code);
    if(!val.existe) throw new Error('Ese Jack no existe en el lote impreso.');
    const nuevo=val.estado==='impresa';
    if(nuevo && amount<config.compraMinJack) throw new Error(`Para activar Jack se requieren al menos ${money(config.compraMinJack)}.`);
    if(!nuevo && val.estado!=='entregada') throw new Error(`Ese Jack no puede recibir una compra pasada en estado ${val.estado}.`);
    const nivelAntes=val.nivel||null;
    const partId=`RETRO-${Date.now().toString(36).toUpperCase()}-${uuid().slice(0,8).toUpperCase()}`;
    const result=nuevo?await Folios.entregar(code,amount,partId):await Folios.acumular(code,amount,partId);
    if(result.usadaEnOtroFolio) throw new Error('Ese movimiento ya fue aplicado a otro Jack.');
    const p=await getProfile(code,true);
    const clean=String(nota||'').trim().slice(0,500);
    if(clean){ p.nota=clean; await saveProfile(p); }
    let fecha=nowIso();
    if(fechaVenta){
      const d=new Date(String(fechaVenta)+'T12:00:00');
      if(!Number.isNaN(d.getTime())) fecha=d.toISOString();
    }
    await addEvent({fecha,tipo:'compra_pasada_jack',partId,codigo:code,monto:amount,acumulado:result.acumulado,nivel:result.nivel,nuevo,nota:clean});
    const profile=await getProfile(code,true);
    const cardsOwed=Math.max(0,Math.floor(Number(result.acumulado||0)/config.cartaCada)-Number(profile.freeDelivered||0));
    return {ok:true,result,profile,nuevo,nivelAntes,nivelDespues:result.nivel||null,cardsOwed,partId};
  }

  async function listPendingNoJack({includeClosed=true}={}){
    const tx=db.transaction([STORES.PENDING],'readonly');
    const rows=await reqPromise(tx.objectStore(STORES.PENDING).getAll()); await txPromise(tx);
    return rows.filter(x=>includeClosed||x.estado==='pendiente').map(clone).sort((a,b)=>String(b.actualizadoEn||b.creadoEn||'').localeCompare(String(a.actualizadoEn||a.creadoEn||'')));
  }

  async function getPendingNoJack(id){
    const tx=db.transaction([STORES.PENDING],'readonly'); const row=await reqPromise(tx.objectStore(STORES.PENDING).get(String(id))); await txPromise(tx);
    return row?clone(row):null;
  }

  async function savePendingNoJack({id=null,alias='',acumulado=0,cartasEntregadas=0,nota=''}){
    await requireWriter();
    const amount=Math.max(0,Number(acumulado)||0), cards=Math.max(0,Math.floor(Number(cartasEntregadas)||0));
    const earned=Math.floor(amount/config.cartaCada);
    if(cards>earned) throw new Error(`Con ${money(amount)} sólo corresponden ${earned} carta(s) gratis. Revisa “cartas entregadas”.`);
    const cleanAlias=String(alias||'').trim().slice(0,80); if(!cleanAlias) throw new Error('Pon un alias o recordatorio para identificar a la persona.');
    const cleanNote=String(nota||'').trim().slice(0,500);
    let rec=id?await getPendingNoJack(id):null;
    if(rec && rec.estado!=='pendiente') throw new Error('Ese registro ya está cerrado o convertido a Jack.');
    const now=nowIso();
    if(!rec) rec={id:uuid(),alias:cleanAlias,acumulado:amount,cartasEntregadas:cards,nota:cleanNote,estado:'pendiente',creadoEn:now,actualizadoEn:now};
    else Object.assign(rec,{alias:cleanAlias,acumulado:amount,cartasEntregadas:cards,nota:cleanNote,actualizadoEn:now});
    const tx=db.transaction([STORES.PENDING],'readwrite'); tx.objectStore(STORES.PENDING).put(clone(rec)); await txPromise(tx);
    await addEvent({tipo:'sin_jack_guardado',pendingId:rec.id,monto:amount,cantidad:cards,nota:`${cleanAlias}${cleanNote?' · '+cleanNote:''}`});
    return clone(rec);
  }

  async function closePendingNoJack(id){
    await requireWriter(); const rec=await getPendingNoJack(id); if(!rec) throw new Error('Acumulación sin Jack no encontrada.');
    if(rec.estado!=='pendiente') return rec;
    rec.estado='cerrado';rec.cerradoEn=nowIso();rec.actualizadoEn=rec.cerradoEn;
    const tx=db.transaction([STORES.PENDING],'readwrite');tx.objectStore(STORES.PENDING).put(clone(rec));await txPromise(tx);
    await addEvent({tipo:'sin_jack_cerrado',pendingId:rec.id,monto:rec.acumulado,cantidad:rec.cartasEntregadas,nota:rec.alias});
    return clone(rec);
  }

  async function convertPendingNoJack(id,codigo){
    await requireWriter(); const rec=await getPendingNoJack(id); if(!rec) throw new Error('Acumulación sin Jack no encontrada.');
    if(rec.estado!=='pendiente') throw new Error('Ese registro ya no está pendiente.');
    if(Number(rec.acumulado||0)<config.compraMinJack) throw new Error(`Todavía no llega a ${money(config.compraMinJack)} para activar un Jack.`);
    const code=normalizeCode(codigo); if(!code) throw new Error('Escribe el código Jack.');
    const val=await Folios.validar(code); if(!val.existe) throw new Error('Ese Jack no existe en el lote impreso.');
    if(val.estado!=='impresa') throw new Error(`Ese Jack no está disponible para activar (${val.estado}).`);
    const partId=`PEND-${String(rec.id).slice(0,18)}-${Date.now().toString(36).toUpperCase()}`;
    const result=await Folios.entregar(code,Number(rec.acumulado||0),partId);
    if(result.usadaEnOtroFolio) throw new Error('Ese movimiento ya fue aplicado a otro Jack.');
    const profile=await getProfile(code,true), already=Number(profile.freeDelivered||0), delivered=Math.max(0,Math.floor(Number(rec.cartasEntregadas)||0));
    for(let i=already;i<delivered;i++) profile.cardHistory.push({id:null,fecha:nowIso(),ventaId:partId,source:'sin_jack_previo'});
    profile.freeDelivered=Math.max(already,delivered);
    if(!String(profile.nota||'').trim()) profile.nota=[rec.alias,rec.nota].filter(Boolean).join(' · ').slice(0,500);
    await saveProfile(profile);
    rec.estado='convertido';rec.codigo=code;rec.convertidoEn=nowIso();rec.actualizadoEn=rec.convertidoEn;
    {const tx=db.transaction([STORES.PENDING],'readwrite');tx.objectStore(STORES.PENDING).put(clone(rec));await txPromise(tx);}
    await addEvent({tipo:'sin_jack_convertido',pendingId:rec.id,partId,codigo:code,monto:rec.acumulado,acumulado:result.acumulado,nivel:result.nivel,cantidad:delivered,nota:rec.alias});
    const snap=await jackSnapshot(code);
    return {ok:true,record:clone(rec),result,snapshot:snap,cardsOwed:snap.freePending};
  }

  async function addEvent(evt){
    const e={id:uuid(),fecha:nowIso(),...evt};
    const tx=db.transaction([STORES.EVENTS],'readwrite'); tx.objectStore(STORES.EVENTS).add(e); await txPromise(tx); return e;
  }

  async function captureSale(detail){
    const items=sanitizeItems(detail.items);
    const sale={
      ventaId:String(detail.ventaId), fecha:detail.fecha||nowIso(), total:Number(detail.total)||0,
      canal:detail.canal||'', vendedor:detail.vendedor||'', itemsCount:items.length, items,
      allocations:[], unallocated:Number(detail.total)||0, anonymousCardsDelivered:0, closed:false, createdAt:nowIso()
    };
    const tx=db.transaction([STORES.SALES],'readwrite');
    const st=tx.objectStore(STORES.SALES); const old=await reqPromise(st.get(sale.ventaId));
    if(!old) st.add(sale);
    else if((!Array.isArray(old.items)||old.items.length===0) && items.length){ old.items=items; old.itemsCount=items.length; st.put(old); }
    await txPromise(tx);
    return old?clone({...old,items:(old.items?.length?old.items:items),itemsCount:(old.items?.length?old.items.length:items.length)}):clone(sale);
  }

  async function getSale(ventaId){
    const tx=db.transaction([STORES.SALES],'readonly'); const s=await reqPromise(tx.objectStore(STORES.SALES).get(String(ventaId))); await txPromise(tx); return s?clone(s):null;
  }

  async function getJackSales(codigo){
    const code=normalizeCode(codigo); if(!code)return [];
    const tx=db.transaction([STORES.SALES],'readonly'); const rows=await reqPromise(tx.objectStore(STORES.SALES).getAll()); await txPromise(tx);
    return rows.filter(s=>(s.allocations||[]).some(a=>normalizeCode(a.codigo)===code)).map(s=>{
      const mine=(s.allocations||[]).filter(a=>normalizeCode(a.codigo)===code);
      return {...clone(s), aplicado:mine.reduce((a,x)=>a+Number(x.monto||0),0), misPartes:clone(mine)};
    }).sort((a,b)=>String(b.fecha||b.createdAt).localeCompare(String(a.fecha||a.createdAt)));
  }

  async function getJackEvents(codigo){
    const code=normalizeCode(codigo); if(!code)return [];
    const tx=db.transaction([STORES.EVENTS],'readonly'); const rows=await reqPromise(tx.objectStore(STORES.EVENTS).getAll()); await txPromise(tx);
    return rows.filter(e=>normalizeCode(e.codigo)===code).map(clone).sort((a,b)=>String(b.fecha||'').localeCompare(String(a.fecha||'')));
  }

  async function saveSale(s){
    s.unallocated=Math.max(0, Number(s.total)-s.allocations.reduce((a,x)=>a+Number(x.monto||0),0));
    const tx=db.transaction([STORES.SALES],'readwrite'); tx.objectStore(STORES.SALES).put(clone(s)); await txPromise(tx); return clone(s);
  }

  async function folioHasSale(partId){
    const exp=await Folios.exportar();
    for(const f of exp.folios||[]) for(const h of f.historial||[]) if(String(h.ventaId||'')===String(partId)) return {codigo:f.codigo,evento:h};
    return null;
  }

  async function applyAllocation({ventaId,codigo,monto,nuevo}){
    await requireWriter();
    const sale=await getSale(ventaId); if(!sale) throw new Error('Venta Halloween no encontrada.');
    const amount=Number(monto);
    if(!Number.isFinite(amount)||amount<=0) throw new Error('Monto inválido.');
    if(amount>sale.unallocated+0.0001) throw new Error('El reparto supera lo que queda de la venta.');
    const code=normalizeCode(codigo); if(!code) throw new Error('Escribe el código Jack.');
    const val=await Folios.validar(code);
    if(!val.existe) throw new Error('Ese Jack no existe en el lote impreso.');
    if(nuevo===undefined || nuevo===null) nuevo = val.estado==='impresa';
    if(nuevo && amount<config.compraMinJack) throw new Error(`Para activar Jack se requieren al menos ${money(config.compraMinJack)}.`);
    if(nuevo && val.estado!=='impresa') throw new Error(`Ese Jack no está disponible para activar (${val.estado}).`);
    if(!nuevo && val.estado!=='entregada') throw new Error(`Ese Jack no está activo (${val.estado}).`);

    const nivelAntes=val.nivel||null;
    const partId=`${sale.ventaId}:${String(sale.allocations.length+1).padStart(2,'0')}`;
    const op={id:uuid(),tipo:'aplicar_venta',estado:'pendiente',ventaId:sale.ventaId,partId,codigo:code,monto:amount,nuevo,creadoEn:nowIso()};
    {
      const tx=db.transaction([STORES.OPS],'readwrite'); tx.objectStore(STORES.OPS).add(op); await txPromise(tx);
    }

    let result;
    if(nuevo) result=await Folios.entregar(code,amount,partId); else result=await Folios.acumular(code,amount,partId);
    if(result.usadaEnOtroFolio) throw new Error('Ese movimiento ya fue aplicado a otro Jack.');

    sale.allocations.push({partId,codigo:code,monto:amount,nuevo,fecha:nowIso()});
    await saveSale(sale);
    const p=await getProfile(code,true);
    await addEvent({tipo:nuevo?'jack_activado':'venta_acumulada',ventaId:sale.ventaId,partId,codigo:code,monto:amount,acumulado:result.acumulado,nivel:result.nivel});
    op.estado='completada'; op.completadoEn=nowIso();
    { const tx=db.transaction([STORES.OPS],'readwrite'); tx.objectStore(STORES.OPS).put(op); await txPromise(tx); }
    return {result,profile:p,sale:await getSale(ventaId),nuevo,nivelAntes,nivelDespues:result.nivel||null,cardsOwed:Math.max(0,Math.floor(Number(result.acumulado||0)/config.cartaCada)-Number(p.freeDelivered||0))};
  }

  async function closeSaleWithoutJack(ventaId){
    const sale=await getSale(ventaId); if(!sale) return null;
    sale.closed=true; await saveSale(sale);
    await addEvent({tipo:'venta_sin_jack',ventaId:sale.ventaId,monto:sale.unallocated,cartas:0});
    return {sale,cardsOwed:0};
  }

  async function listInventory(){
    const tx=db.transaction([STORES.INVENTORY],'readonly'); const arr=await reqPromise(tx.objectStore(STORES.INVENTORY).getAll()); await txPromise(tx);
    const order={comun:1,rara:2,epica:3}; return arr.sort((a,b)=>order[a.rareza]-order[b.rareza]||a.id.localeCompare(b.id));
  }

  async function setInventory(cardId,stock,numero,nombre){
    const tx=db.transaction([STORES.INVENTORY],'readwrite'); const st=tx.objectStore(STORES.INVENTORY); const c=await reqPromise(st.get(cardId)); if(!c) throw new Error('Carta desconocida');
    if(stock!==undefined){ c.stock=(stock===''||stock===null)?null:Math.max(0,Math.floor(Number(stock)||0)); if(c.inicial===null&&c.stock!==null)c.inicial=c.stock; }
    if(numero!==undefined) c.numero=String(numero||'').trim()||null;
    if(nombre!==undefined && String(nombre).trim()) c.nombre=String(nombre).trim();
    c.actualizadoEn=nowIso(); st.put(c); await txPromise(tx); return clone(c);
  }

  async function registerDraw({codigo=null,ventaId=null,cardIds=[],source='gratis',anonymous=false}){
    if(!Array.isArray(cardIds)||!cardIds.length) return {ok:true,count:0};
    const inv=await listInventory(); const invMap=new Map(inv.map(x=>[x.id,x]));
    const counts={}; for(const id of cardIds) counts[id]=(counts[id]||0)+1;
    for(const [id,n] of Object.entries(counts)){
      const c=invMap.get(id); if(!c) throw new Error(`Carta ${id} desconocida.`);
      if(config.strictInventory && c.stock!==null && c.stock<n) throw new Error(`No hay suficiente ${c.nombre} en inventario.`);
    }

    const tx=db.transaction([STORES.INVENTORY,STORES.PROFILES,STORES.SALES,STORES.EVENTS],'readwrite');
    const invSt=tx.objectStore(STORES.INVENTORY), pSt=tx.objectStore(STORES.PROFILES), sSt=tx.objectStore(STORES.SALES), eSt=tx.objectStore(STORES.EVENTS);
    const fecha=nowIso();
    for(const [id,n] of Object.entries(counts)){
      const c=await reqPromise(invSt.get(id)); if(c.stock!==null)c.stock=Math.max(0,c.stock-n); c.actualizadoEn=fecha; invSt.put(c);
    }
    let p=null;
    if(codigo){
      const code=normalizeCode(codigo); p=await reqPromise(pSt.get(code));
      if(!p) p={ codigo:code, creadoEn:fecha, actualizadoEn:fecha, freeDelivered:0, cardHistory:[], rescates:0, catrina:false, charro:false, albumComplete:false, reportedOwned:[], reportedAt:null, nota:'' };
      for(const id of cardIds) p.cardHistory.push({id,fecha,ventaId:ventaId||null,source});
      if(source==='gratis') p.freeDelivered=Number(p.freeDelivered||0)+cardIds.length;
      if(source==='rescate') p.rescates=Number(p.rescates||0)+cardIds.length;
      p.actualizadoEn=fecha; pSt.put(p);
    }
    if(anonymous && ventaId){
      const s=await reqPromise(sSt.get(String(ventaId))); if(s){ s.anonymousCardsDelivered=Number(s.anonymousCardsDelivered||0)+cardIds.length; sSt.put(s); }
    }
    eSt.add({id:uuid(),fecha,tipo:'cartas_entregadas',ventaId:ventaId||null,codigo:codigo?normalizeCode(codigo):null,source,cardIds:clone(cardIds),cantidad:cardIds.length});
    await txPromise(tx);
    return {ok:true,count:cardIds.length,profile:p?clone(p):null};
  }

  async function registerQuickCards({codigo=null,ventaId=null,count=0,source='gratis',anonymous=false}){
    const n=Math.max(0,Math.floor(Number(count)||0)); if(!n)return {ok:true,count:0};
    const fecha=nowIso();
    const tx=db.transaction([STORES.PROFILES,STORES.SALES,STORES.EVENTS],'readwrite');
    const pSt=tx.objectStore(STORES.PROFILES), sSt=tx.objectStore(STORES.SALES), eSt=tx.objectStore(STORES.EVENTS);
    if(codigo){
      const code=normalizeCode(codigo); let p=await reqPromise(pSt.get(code));
      if(!p)p={codigo:code,creadoEn:fecha,actualizadoEn:fecha,freeDelivered:0,cardHistory:[],rescates:0,catrina:false,charro:false,albumComplete:false,reportedOwned:[],reportedAt:null,nota:''};
      for(let i=0;i<n;i++)p.cardHistory.push({id:null,fecha,ventaId:ventaId||null,source:'rapida'});
      if(source==='gratis')p.freeDelivered=Number(p.freeDelivered||0)+n;
      p.actualizadoEn=fecha;pSt.put(p);
    }
    if(anonymous&&ventaId){ const s=await reqPromise(sSt.get(String(ventaId)));if(s){s.anonymousCardsDelivered=Number(s.anonymousCardsDelivered||0)+n;sSt.put(s);} }
    eSt.add({id:uuid(),fecha,tipo:'cartas_entrega_rapida',ventaId:ventaId||null,codigo:codigo?normalizeCode(codigo):null,source,cantidad:n});
    await txPromise(tx); return {ok:true,count:n};
  }

  async function jackSnapshot(codigo){
    const code=normalizeCode(codigo); const f=await Folios.validar(code); if(!f.existe)return {existe:false,codigo:code};
    const p=await getProfile(code,true); const earned=Math.floor(Number(f.acumulado||0)/config.cartaCada);
    return {...f,profile:p,freeEarned:earned,freePending:Math.max(0,earned-Number(p.freeDelivered||0))};
  }

  async function markCatrina(codigo,value=true){
    const p=await getProfile(codigo,true); p.catrina=!!value; await saveProfile(p); await addEvent({tipo:value?'catrina_entregada':'catrina_revertida',codigo:p.codigo}); return p;
  }

  async function saveReportedOwned(codigo,ids){
    const p=await getProfile(codigo,true); p.reportedOwned=[...new Set(ids||[])]; p.reportedAt=nowIso(); await saveProfile(p); await addEvent({tipo:'album_declarado',codigo:p.codigo,cardIds:p.reportedOwned}); return p;
  }

  async function redeem(codigo,physicalConfirmed){
    if(!physicalConfirmed) throw new Error('Para el canje final debe presentarse Jack físico.');
    const code=normalizeCode(codigo); const before=await jackSnapshot(code); if(!before.existe)throw new Error('Jack inexistente.');
    if(before.estado==='canjeada') return {yaCanjeada:true,snapshot:before};
    if(before.freePending>0) throw new Error(`Tiene ${before.freePending} carta(s) gratis pendiente(s) de registrar/entregar.`);
    const r=await Folios.canjear(code);
    const p=await getProfile(code,true); p.charro=true; await saveProfile(p);
    await addEvent({tipo:'canje_final',codigo:code,acumulado:r.acumulado,nivel:r.nivel,charro:true});
    return {yaCanjeada:false,result:r,profile:p};
  }

  async function summary(){
    const [inv,fol]=await Promise.all([listInventory(),Folios.exportar()]);
    const tx=db.transaction([STORES.PROFILES,STORES.EVENTS,STORES.SALES,STORES.OPS],'readonly');
    const [profiles,events,sales,ops]=await Promise.all([
      reqPromise(tx.objectStore(STORES.PROFILES).getAll()),reqPromise(tx.objectStore(STORES.EVENTS).getAll()),reqPromise(tx.objectStore(STORES.SALES).getAll()),reqPromise(tx.objectStore(STORES.OPS).getAll())
    ]); await txPromise(tx);
    const active=(fol.folios||[]).filter(x=>x.estado==='entregada'||x.estado==='canjeada');
    const vals=active.map(x=>Number(x.acumulado||0));
    const levels={N1:0,N2:0,N3:0,N4:0,sin_nivel:0};
    for(const x of active){ const v=LEVELS.filter(l=>Number(x.acumulado)>=l.min).pop(); levels[v?v.id:'sin_nivel']++; }
    const counts={}; for(const e of events.filter(x=>x.tipo==='cartas_entregadas')) for(const id of e.cardIds||[]) counts[id]=(counts[id]||0)+1;
    const pendingNoJack=await listPendingNoJack({includeClosed:false});
    return {
      jacksActivos:active.length, acumuladoTotal:vals.reduce((a,b)=>a+b,0), acumuladoPromedio:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0,
      niveles:levels, perfiles:profiles.length, ventasHalloween:sales.length, pendientesOps:ops.filter(x=>x.estado!=='completada').length,pendingNoJack:pendingNoJack.length,
      inventario:inv, cartasRegistradas:counts, eventos:events.length
    };
  }

  async function exportAll(){
    const folios=await Folios.exportar();
    const tx=db.transaction(Object.values(STORES),'readonly');
    const data={};
    for(const [k,name] of Object.entries(STORES)) data[k.toLowerCase()]=await reqPromise(tx.objectStore(name).getAll());
    await txPromise(tx);
    return {type:'Halloween2026Backup',version:APP_VERSION,exportedAt:nowIso(),config:clone(config),folios,halloween:data};
  }

  function parseFullBackup(input){
    let data=input;
    if(typeof input==='string'){
      try{ data=JSON.parse(input); }catch(_){ throw new Error('El archivo no contiene JSON válido.'); }
    }
    if(!data||typeof data!=='object'||data.type!=='Halloween2026Backup'||!data.folios||!data.halloween) throw new Error('No parece un respaldo completo Halloween 2026.');
    return data;
  }

  async function getStoreRows(name){
    const tx=db.transaction([name],'readonly'); const rows=await reqPromise(tx.objectStore(name).getAll()); await txPromise(tx); return rows;
  }
  function isoMs(v){ const n=Date.parse(v||''); return Number.isFinite(n)?n:0; }
  function unionByKey(a,b,keyFn){
    const out=[], seen=new Set();
    for(const x of [...(a||[]),...(b||[])]){ const k=keyFn(x); if(seen.has(k))continue; seen.add(k); out.push(clone(x)); }
    return out;
  }
  function mergeProfile(local,incoming){
    const useIncoming=isoMs(incoming.actualizadoEn)>isoMs(local.actualizadoEn);
    const newer=useIncoming?incoming:local, older=useIncoming?local:incoming;
    const out={...clone(older),...clone(newer)};
    out.codigo=normalizeCode(local.codigo||incoming.codigo);
    out.cardHistory=unionByKey(local.cardHistory,incoming.cardHistory,x=>JSON.stringify([x?.id??null,x?.fecha||'',x?.ventaId||'',x?.source||'']));
    out.freeDelivered=Math.max(Number(local.freeDelivered||0),Number(incoming.freeDelivered||0));
    out.rescates=Math.max(Number(local.rescates||0),Number(incoming.rescates||0));
    const lr=isoMs(local.reportedAt), ir=isoMs(incoming.reportedAt);
    out.reportedOwned=clone(ir>lr?(incoming.reportedOwned||[]):(local.reportedOwned||[]));
    out.reportedAt=ir>lr?(incoming.reportedAt||null):(local.reportedAt||null);
    return out;
  }
  function mergeSale(local,incoming){
    const out=clone(local); let conflicts=0;
    if((!out.items||!out.items.length) && incoming.items?.length){ out.items=clone(incoming.items); out.itemsCount=out.items.length; }
    if(Number(out.total||0)!==Number(incoming.total||0) && Number(incoming.total||0)>0) conflicts++;
    const map=new Map((out.allocations||[]).map(x=>[String(x.partId||JSON.stringify(x)),x]));
    for(const x of incoming.allocations||[]){ const k=String(x.partId||JSON.stringify(x)); if(!map.has(k)){ (out.allocations||(out.allocations=[])).push(clone(x)); map.set(k,x); } else if(JSON.stringify(map.get(k))!==JSON.stringify(x)) conflicts++; }
    out.closed=!!(local.closed||incoming.closed);
    out.anonymousCardsDelivered=Math.max(Number(local.anonymousCardsDelivered||0),Number(incoming.anonymousCardsDelivered||0));
    out.unallocated=Math.max(0,Number(out.total||0)-(out.allocations||[]).reduce((a,x)=>a+Number(x.monto||0),0));
    return {record:out,conflicts};
  }

  async function analyzeImportAll(input){
    const data=parseFullBackup(input);
    const foliosAnalysis=await Folios.analizarImportacion(data.folios);
    const incoming=data.halloween||{};
    const counts={}; for(const k of ['profiles','sales','events','inventory','ops','pending']) counts[k]=Array.isArray(incoming[k])?incoming[k].length:0;
    return {folios:foliosAnalysis,counts,exportedAt:data.exportedAt||null,version:data.version||null};
  }

  async function importAllMerge(input){
    await requireWriter();
    const data=parseFullBackup(input);
    const incoming=data.halloween||{};
    const current={};
    for(const [k,name] of Object.entries(STORES)) current[k.toLowerCase()]=await getStoreRows(name);
    const foliosBefore=await Folios.exportar();
    const substantiveLocal=((current.profiles?.length||0)+(current.sales?.length||0)+(current.events?.length||0)+(current.ops?.length||0)+(current.pending?.length||0)>0) || ((foliosBefore.folios||[]).length>0);
    const folioAnalysis=await Folios.analizarImportacion(data.folios);
    const folioResult=await Folios.aplicarImportacion(data.folios,{confirmado:true,resolverConflictos:'mantener_local'});
    const stats={profilesAdded:0,profilesMerged:0,salesAdded:0,salesMerged:0,eventsAdded:0,opsAdded:0,pendingAdded:0,pendingMerged:0,inventoryRestored:0,conflicts:0};

    const tx=db.transaction([STORES.PROFILES,STORES.SALES,STORES.EVENTS,STORES.INVENTORY,STORES.OPS,STORES.PENDING],'readwrite');
    const pSt=tx.objectStore(STORES.PROFILES), sSt=tx.objectStore(STORES.SALES), eSt=tx.objectStore(STORES.EVENTS), iSt=tx.objectStore(STORES.INVENTORY), oSt=tx.objectStore(STORES.OPS), nSt=tx.objectStore(STORES.PENDING);
    try{
      const pMap=new Map((current.profiles||[]).map(x=>[normalizeCode(x.codigo),x]));
      for(const raw of incoming.profiles||[]){ const inc=clone(raw); inc.codigo=normalizeCode(inc.codigo); const cur=pMap.get(inc.codigo); if(!cur){pSt.put(inc);stats.profilesAdded++;}else{pSt.put(mergeProfile(cur,inc));stats.profilesMerged++;} }

      const sMap=new Map((current.sales||[]).map(x=>[String(x.ventaId),x]));
      for(const raw of incoming.sales||[]){ const inc=clone(raw); const key=String(inc.ventaId); const cur=sMap.get(key); if(!cur){sSt.put(inc);stats.salesAdded++;}else{const m=mergeSale(cur,inc);sSt.put(m.record);stats.salesMerged++;stats.conflicts+=m.conflicts;} }

      const eIds=new Set((current.events||[]).map(x=>String(x.id)));
      for(const inc of incoming.events||[]){ if(!eIds.has(String(inc.id))){eSt.put(clone(inc));eIds.add(String(inc.id));stats.eventsAdded++;} }

      const oMap=new Map((current.ops||[]).map(x=>[String(x.id),x]));
      for(const inc0 of incoming.ops||[]){ const inc=clone(inc0), key=String(inc.id), cur=oMap.get(key); if(!cur){oSt.put(inc);stats.opsAdded++;}else if(cur.estado==='pendiente'&&inc.estado!=='pendiente'){oSt.put(inc);} }

      const nMap=new Map((current.pending||[]).map(x=>[String(x.id),x]));
      for(const inc0 of incoming.pending||[]){ const inc=clone(inc0),key=String(inc.id),cur=nMap.get(key);if(!cur){nSt.put(inc);stats.pendingAdded++;}else{const use=isoMs(inc.actualizadoEn)>isoMs(cur.actualizadoEn)?inc:cur;nSt.put(clone(use));stats.pendingMerged++;} }

      const iMap=new Map((current.inventory||[]).map(x=>[String(x.id),x]));
      for(const inc0 of incoming.inventory||[]){ const inc=clone(inc0), cur=iMap.get(String(inc.id));
        if(!cur || !substantiveLocal){ iSt.put(inc); stats.inventoryRestored++; }
        else { const merged=clone(cur); if(!merged.numero&&inc.numero)merged.numero=inc.numero; if((merged.stock===null||merged.stock===undefined)&&inc.stock!==null&&inc.stock!==undefined)merged.stock=inc.stock; if(!merged.nombre&&inc.nombre)merged.nombre=inc.nombre; iSt.put(merged); }
      }
      await txPromise(tx);
    }catch(err){ try{tx.abort();}catch(_){} throw err; }

    const incomingMeta=new Map((incoming.meta||[]).map(x=>[String(x.key),x.value]));
    const localExported=new Set((await metaGet('auditExportedIds',[])).map(String));
    for(const id of incomingMeta.get('auditExportedIds')||[]) localExported.add(String(id));
    if(localExported.size) await metaSet('auditExportedIds',[...localExported]);
    const localAudit=await metaGet('lastAuditAt',null), importedAudit=incomingMeta.get('lastAuditAt')||null;
    if(isoMs(importedAudit)>isoMs(localAudit)) await metaSet('lastAuditAt',importedAudit);
    const localBackup=await metaGet('lastBackupAt',null), importedBackup=incomingMeta.get('lastBackupAt')||null;
    if(isoMs(importedBackup)>isoMs(localBackup)) await metaSet('lastBackupAt',importedBackup);
    if(!substantiveLocal && data.config){ config={...DEFAULT_CONFIG,...clone(data.config)}; await metaSet('config',config); }
    await metaSet('lastImportAt',nowIso());
    return {ok:true,folios:folioResult,folioAnalysis,stats,keptLocalConflicts:folioAnalysis.conflictos||0};
  }

  async function auditRows(onlyPending=false){
    const tx=db.transaction([STORES.EVENTS,STORES.SALES],'readonly');
    const [ev,sales]=await Promise.all([reqPromise(tx.objectStore(STORES.EVENTS).getAll()),reqPromise(tx.objectStore(STORES.SALES).getAll())]); await txPromise(tx);
    const exported=new Set(onlyPending?(await metaGet('auditExportedIds',[])).map(String):[]);
    const events=ev.filter(e=>!onlyPending||!exported.has(String(e.id))).sort((a,b)=>String(a.fecha).localeCompare(String(b.fecha)));
    const saleMap=new Map(sales.map(x=>[String(x.ventaId),x]));
    const head=['MovimientoID','Fecha','Evento','VentaID','ParteID','Jack','Monto','Acumulado','Nivel','Cartas','Productos','Nota'];
    const rows=events.map(e=>{
      const sale=saleMap.get(String(e.ventaId||''));
      const productos=(sale?.items||[]).map(i=>`${i.nombre} x${i.cantidad} @${Number(i.precio||0).toFixed(2)}`).join(' | ');
      return [e.id||'',e.fecha||'',e.tipo||'',e.ventaId||'',e.partId||'',e.codigo||'',e.monto??'',e.acumulado??'',e.nivel||'',(e.cardIds||[]).join(','),productos,e.nota||''];
    });
    const includeHead=!onlyPending||exported.size===0;
    const table=includeHead?[head,...rows]:rows;
    return {text:table.map(r=>r.join('\t')).join('\n'),ids:events.map(e=>String(e.id)),count:events.length};
  }
  async function auditTSV(){ return (await auditRows(false)).text; }
  async function auditPendingTSV(){ return auditRows(true); }
  async function setAuditPendingConfirm(ids){ await metaSet('auditPendingConfirmIds',[...new Set((ids||[]).map(String))]); }
  async function markAuditExported(ids){
    const cur=new Set((await metaGet('auditExportedIds',[])).map(String)); for(const id of ids||[])cur.add(String(id));
    await metaSet('auditExportedIds',[...cur]); await metaSet('auditPendingConfirmIds',[]); await metaSet('lastAuditAt',nowIso()); return cur.size;
  }
  async function backupStatus(){
    const ev=await getStoreRows(STORES.EVENTS), exported=new Set((await metaGet('auditExportedIds',[])).map(String));
    const confirmIds=await metaGet('auditPendingConfirmIds',[]);
    return {pending:ev.filter(e=>!exported.has(String(e.id))).length,total:ev.length,lastAuditAt:await metaGet('lastAuditAt',null),lastBackupAt:await metaGet('lastBackupAt',null),lastImportAt:await metaGet('lastImportAt',null),pendingConfirmIds:confirmIds||[]};
  }
  async function markBackupNow(){ const t=nowIso(); await metaSet('lastBackupAt',t); return t; }

  async function reconcileOps(){
    const tx=db.transaction([STORES.OPS],'readonly'); const ops=await reqPromise(tx.objectStore(STORES.OPS).getAll()); await txPromise(tx);
    const pending=ops.filter(x=>x.estado==='pendiente'); if(!pending.length)return [];
    const exp=await Folios.exportar(); const seen=new Map();
    for(const f of exp.folios||[])for(const h of f.historial||[])if(h.ventaId)seen.set(String(h.ventaId),{codigo:f.codigo,h});
    const recovered=[];
    for(const op of pending){
      if(seen.has(String(op.partId))){ op.estado='folio_aplicado_pendiente_revision'; op.detectadoEn=nowIso(); recovered.push(op); const w=db.transaction([STORES.OPS],'readwrite');w.objectStore(STORES.OPS).put(op);await txPromise(w); }
    }
    return recovered;
  }

  async function clearFoliosForTests(){
    // Limpiamos la MISMA base usada por folios_v2.js y verificamos después con
    // su propia API. Así nunca mostramos “borrado” si los Jacks siguen ahí.
    let before=0;
    try{ before=(await Folios.exportar()).folios?.length||0; }catch(_){}
    const d=await new Promise((resolve,reject)=>{ const r=indexedDB.open('folios_HW2026'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error||new Error('No se pudo abrir Folios')); });
    try{
      const stores=['folios','meta','ventas'].filter(x=>d.objectStoreNames.contains(x));
      if(stores.length){
        const tx=d.transaction(stores,'readwrite');
        for(const name of stores) tx.objectStore(name).clear();
        await txPromise(tx);
      }
    }finally{ d.close(); }
    const after=(await Folios.exportar()).folios?.length||0;
    if(after!==0) throw new Error(`La verificación encontró ${after} Jack(s) todavía guardados. No se reportó el borrado como exitoso.`);
    return {before,after};
  }

  async function getOperationalMode(){
    const mode=await metaGet('operationalMode','pruebas');
    return mode==='produccion'?'produccion':'pruebas';
  }
  async function setOperationalMode(mode){
    const next=mode==='produccion'?'produccion':'pruebas';
    await metaSet('operationalMode',next); return next;
  }

  async function resetSeasonForTests(){
    await requireWriter();
    if(await getOperationalMode()==='produccion') throw new Error('Modo PRODUCCIÓN activo. Vuelve deliberadamente a modo pruebas antes de borrar.');
    const names=Object.values(STORES); const tx=db.transaction(names,'readwrite'); for(const name of names)tx.objectStore(name).clear(); await txPromise(tx);
    config={...DEFAULT_CONFIG}; await metaSet('config',config); await metaSet('operationalMode','pruebas'); await ensureInventory();
    const foliosClear=await clearFoliosForTests();
    return {ok:true,foliosBorrados:foliosClear.before};
  }

  async function configure(patch){ config={...config,...patch}; await metaSet('config',config); return clone(config); }

  const Core=Object.freeze({
    init:initCore,configure,get config(){return clone(config);},levels:LEVELS,cards:DEFAULT_CARDS,
    captureSale,getSale,getJackSales,getJackEvents,applyAllocation,closeSaleWithoutJack,getProfile,jackSnapshot,listInventory,setInventory,registerDraw,registerQuickCards,
    markCatrina,saveReportedOwned,saveJackNote,registerPastJack,listPendingNoJack,getPendingNoJack,savePendingNoJack,closePendingNoJack,convertPendingNoJack,redeem,summary,exportAll,auditTSV,auditPendingTSV,setAuditPendingConfirm,markAuditExported,backupStatus,markBackupNow,
    analyzeImportAll,importAllMerge,reconcileOps,acquireWriterLock,folioHasSale,resetSeasonForTests,getOperationalMode,setOperationalMode
  });
  root.Halloween2026=Core;

  /* =========================== UI =========================== */
  const UI={ currentSale:null, currentJack:null, selectedCards:[], drawContext:null, albumContext:null, pendingEditingId:null, finalizedSales:new Set(), initialized:false, noJackConfirmUntil:0, noJackTimer:null, scanner:null };

  function injectStyles(){
    const s=document.createElement('style'); s.textContent=`
      .hw-btn{background:#5f338d!important;color:#fff!important;border-color:#8156ad!important}
      .hw-card{border-color:#70449b!important}.hw-accent{color:#d8a8ff}.hw-muted{color:var(--text-muted);font-size:12px}
      .hw-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:10px}
      .hw-stat{background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:9px;text-align:center}.hw-stat b{display:block;font-size:17px}
      .hw-cardgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;max-height:44vh;overflow:auto;margin-top:10px}
      .hw-cardpick{background:var(--surface-2);color:var(--text);border:1px solid var(--border);padding:9px 7px;font-size:12px;position:relative}
      .hw-cardpick.sel{outline:2px solid var(--accent)}.hw-cardpick small{display:block;color:var(--text-muted);font-weight:500}
      .hw-count{position:absolute;top:3px;right:4px;background:var(--accent);color:var(--accent-ink);border-radius:10px;padding:1px 6px;font-size:10px}
      .hw-overlay{z-index:220}.hw-wide{max-width:440px}#hwQrOverlay{z-index:10000!important;background:rgba(0,0,0,.88)!important}#hwAlbumOverlay{z-index:600!important}.hw-line{display:flex;gap:8px;align-items:center}.hw-line>*{flex:1}
      .hw-checkgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;max-height:58vh;overflow:auto;margin-top:10px}
      .hw-checkpick{display:flex;align-items:center;gap:8px;text-align:left;background:var(--surface-2);color:var(--text);border:1px solid var(--border);padding:9px;border-radius:10px;font-size:12px;min-height:46px}
      .hw-checkpick.sel{outline:2px solid var(--accent);background:var(--surface)}.hw-checkmark{flex:0 0 22px;width:22px;height:22px;border-radius:6px;border:1px solid var(--border);display:grid;place-items:center;font-weight:900}.hw-checkpick.sel .hw-checkmark{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
      .hw-danger{color:var(--danger)}.hw-ok{color:var(--ok)}.hw-section{margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}
      .hw-pill{display:inline-block;padding:3px 8px;border-radius:20px;background:var(--surface-2);font-size:11px;margin:2px}
      .hw-scan-video{width:100%;aspect-ratio:3/4;max-height:60vh;object-fit:cover;background:#000;border-radius:12px;border:1px solid var(--border)}
      .hw-scan-frame{position:relative}.hw-scan-frame:after{content:"";position:absolute;inset:18% 12%;border:2px solid var(--accent);border-radius:14px;pointer-events:none}
      .hw-scan-btn{flex:0 0 auto;min-width:48px;padding-left:11px;padding-right:11px}
    `; document.head.appendChild(s);
  }

  function injectUI(){
    const headerIcons=document.querySelector('.header-icons');
    if(headerIcons&&!document.getElementById('btnHalloweenMode')){
      const b=document.createElement('button'); b.id='btnHalloweenMode'; b.className='icon-btn'; b.type='button'; b.title='Halloween 2026'; b.textContent='🎃'; b.style.display='none';
      b.addEventListener('click',openDashboard); headerIcons.appendChild(b);
    }

    const saleOverlay=document.createElement('div'); saleOverlay.id='hwSaleOverlay'; saleOverlay.className='overlay hw-overlay'; saleOverlay.style.display='none'; saleOverlay.innerHTML=`
      <div class="overlay-card hw-wide"><div class="overlay-header"><strong>🎃 Halloween · Jack</strong><button class="close-x" id="hwSaleClose">✕</button></div>
      <div id="hwSaleBody"></div></div>`; document.body.appendChild(saleOverlay);
    document.getElementById('hwSaleClose').onclick=()=>{ clearSaleTransient(); saleOverlay.style.display='none'; };

    const retro=document.createElement('div'); retro.id='hwPastJackOverlay'; retro.className='overlay hw-overlay'; retro.style.display='none'; retro.innerHTML=`
      <div class="overlay-card hw-wide"><div class="overlay-header"><strong>🕘 Registrar compra pasada</strong><button class="close-x" id="hwPastJackClose">✕</button></div>
      <div class="hw-muted">Úsalo cuando la venta ya ocurrió y sólo falta reflejarla en el Jack. No crea otra venta en el ERP.</div>
      <div class="field" style="margin-top:10px;"><label>Código Jack</label><div class="hw-line"><input id="hwPastJackCode" type="text" placeholder="H26-XXXXXX" autocomplete="off"><button class="btn-secondary hw-scan-btn" id="hwPastJackScan" type="button" title="Escanear QR">📷</button></div></div>
      <div class="field" style="margin-top:8px;"><label>Monto de aquella compra</label><input id="hwPastJackAmount" type="number" min="0.01" step="0.01" placeholder="0.00"></div>
      <div class="field" style="margin-top:8px;"><label>Fecha de la compra</label><input id="hwPastJackDate" type="date"></div>
      <div class="field" style="margin-top:8px;"><label>Nota / nombre / recordatorio (opcional)</label><textarea id="hwPastJackNote" maxlength="500" rows="3" placeholder="Ej. Cliente del domingo · faltan sus cartas"></textarea></div>
      <button class="btn-primary" id="hwPastJackSave" style="margin-top:10px;">Registrar en Jack</button>
      <button class="btn-secondary btn-block" id="hwPastJackCancel" style="margin-top:8px;">Cancelar</button>
      </div>`; document.body.appendChild(retro);
    document.getElementById('hwPastJackClose').onclick=closePastJack;
    document.getElementById('hwPastJackCancel').onclick=closePastJack;
    document.getElementById('hwPastJackSave').onclick=savePastJack;
    document.getElementById('hwPastJackScan').onclick=()=>openQrScanner(code=>{ const el=document.getElementById('hwPastJackCode'); if(el)el.value=code; });

    const pending=document.createElement('div'); pending.id='hwPendingNoJackOverlay'; pending.className='overlay hw-overlay'; pending.style.display='none'; pending.innerHTML=`
      <div class="overlay-card hw-wide"><div class="overlay-header"><strong>🧾 Acumulación sin Jack</strong><button class="close-x" id="hwPendingNoJackClose">✕</button></div>
      <div class="hw-muted">Sólo para excepciones que tú reconoces. No crea una venta ni activa un Jack hasta que lo conviertas.</div>
      <div class="field" style="margin-top:10px;"><label>Alias / recordatorio</label><input id="hwPendingAlias" type="text" maxlength="80" placeholder="Ej. Niño de las cartas"></div>
      <div class="field" style="margin-top:8px;"><label>Acumulado reconocido</label><input id="hwPendingAmount" type="number" min="0" step="0.01" value="0"></div>
      <div class="field" style="margin-top:8px;"><label>Cartas gratis ya entregadas</label><input id="hwPendingCards" type="number" min="0" step="1" value="0"></div>
      <div class="field" style="margin-top:8px;"><label>Nota (opcional)</label><textarea id="hwPendingNote" maxlength="500" rows="3"></textarea></div>
      <button class="btn-primary" id="hwPendingSave" style="margin-top:10px;">Guardar</button>
      <button class="btn-secondary btn-block" id="hwPendingCancel" style="margin-top:8px;">Cancelar</button>
      </div>`; document.body.appendChild(pending);
    document.getElementById('hwPendingNoJackClose').onclick=closePendingEditor;
    document.getElementById('hwPendingCancel').onclick=closePendingEditor;
    document.getElementById('hwPendingSave').onclick=savePendingEditor;

    const scanner=document.createElement('div'); scanner.id='hwQrOverlay'; scanner.className='overlay hw-overlay'; scanner.style.display='none'; scanner.innerHTML=`
      <div class="overlay-card hw-wide"><div class="overlay-header"><strong>📷 Escanear Jack</strong><button class="close-x" id="hwQrClose">✕</button></div>
      <div class="hw-scan-frame"><video id="hwQrVideo" class="hw-scan-video" playsinline muted></video></div>
      <div id="hwQrStatus" class="hw-muted" style="margin-top:8px;">Apunta al QR del Jack.</div>
      <button class="btn-secondary btn-block" id="hwQrCancel" style="margin-top:10px;">Cancelar</button>
      </div>`; document.body.appendChild(scanner);
    document.getElementById('hwQrClose').onclick=stopQrScanner;
    document.getElementById('hwQrCancel').onclick=stopQrScanner;

    const draw=document.createElement('div'); draw.id='hwDrawOverlay'; draw.className='overlay hw-overlay'; draw.style.display='none'; draw.innerHTML=`
      <div class="overlay-card hw-wide"><div class="overlay-header"><strong>🃏 Registrar cartas de la urna</strong><button class="close-x" id="hwDrawClose">✕</button></div>
      <div id="hwDrawIntro" class="hw-muted"></div>
      <div class="hw-muted" style="margin-top:5px;">Toque corto = +1 · mantener presionado = −1. Las repetidas sí se pueden registrar.</div>
      <div id="hwCardGrid" class="hw-cardgrid"></div>
      <div class="total-line"><span>Seleccionadas</span><strong id="hwDrawCount">0/0</strong></div>
      <button class="btn-primary" id="hwDrawConfirm">Confirmar cartas</button>
      <button class="btn-secondary btn-block" id="hwDrawQuick" style="margin-top:8px;">⚡ Entrega rápida sin registrar cuáles</button>
      </div>`; document.body.appendChild(draw);
    document.getElementById('hwDrawClose').onclick=()=>{ draw.style.display='none'; };
    document.getElementById('hwDrawConfirm').onclick=confirmDraw;
    document.getElementById('hwDrawQuick').onclick=confirmQuickDraw;

    const album=document.createElement('div'); album.id='hwAlbumOverlay'; album.className='overlay hw-overlay'; album.style.display='none'; album.innerHTML=`
      <div class="overlay-card hw-wide" style="max-height:90vh;overflow:auto;"><div class="overlay-header"><strong>🗂️ Cartas que dice tener ahora</strong><button class="close-x" id="hwAlbumClose">✕</button></div>
      <div class="hw-muted">Marca solamente las cartas que el cliente muestra o declara tener en este momento. Esto no cambia lo que el puesto ya registró como entregado.</div>
      <div id="hwAlbumGrid" class="hw-checkgrid"></div>
      <div class="total-line"><span>Marcadas</span><strong id="hwAlbumCount">0/17</strong></div>
      <button class="btn-primary" id="hwAlbumSave">Guardar estado declarado</button>
      <button class="btn-secondary btn-block" id="hwAlbumCancel" style="margin-top:8px;">Cancelar</button>
      </div>`; document.body.appendChild(album);
    const closeAlbum=()=>{ album.style.display='none'; UI.albumContext=null; };
    document.getElementById('hwAlbumClose').onclick=closeAlbum;
    document.getElementById('hwAlbumCancel').onclick=closeAlbum;
    document.getElementById('hwAlbumSave').onclick=saveAlbumState;

    const dash=document.createElement('div'); dash.id='hwDashboardOverlay'; dash.className='overlay hw-overlay'; dash.style.display='none'; dash.innerHTML=`
      <div class="overlay-card hw-wide" style="max-height:90vh;overflow:auto;"><div class="overlay-header"><strong>🎃 Halloween 2026</strong><button class="close-x" id="hwDashClose">✕</button></div>
      <div id="hwSystemStatus" class="hw-muted"></div>
      <div class="hw-grid" id="hwStats"></div>
      <div class="hw-section"><strong>Buscar Jack</strong><div class="hw-muted" style="margin-top:4px;">Busca un Jack para ver o editar su <b>nota / nombre / recordatorio</b>.</div><div class="hw-line" style="margin-top:8px;"><input id="hwLookupCode" type="text" placeholder="H26-XXXXXX"><button class="btn-secondary hw-scan-btn" id="hwLookupScan" title="Escanear QR">📷</button><button class="btn-secondary" id="hwLookupBtn">Buscar</button></div><button class="btn-secondary btn-block" id="hwPastJackOpen" style="margin-top:8px;">🕘 Registrar compra pasada / Jack pendiente</button><div id="hwJackPanel"></div></div>
      <details class="hw-section" id="hwPendingDetails"><summary style="cursor:pointer;font-weight:700;">🧾 Acumulación sin Jack <span id="hwPendingCount" class="hw-muted"></span></summary><div class="hw-muted" style="margin-top:7px;">Para casos especiales que tú reconoces. Si nunca llega a $50, se puede cerrar sin crear un Jack.</div><button class="btn-secondary btn-block" id="hwPendingNew" style="margin-top:8px;">＋ Nueva acumulación</button><div id="hwPendingList" style="margin-top:8px;"></div></details>
      <div class="hw-muted" style="margin-top:14px;">Configuración, inventario, lotes y respaldos están en ⚙️ Opciones.</div>
      </div>`; document.body.appendChild(dash);
    document.getElementById('hwDashClose').onclick=()=>{ clearDashboardTransient(); dash.style.display='none'; document.getElementById('btnHalloweenMode')?.classList.remove('active');};
    document.getElementById('hwLookupBtn').onclick=lookupJack;
    document.getElementById('hwLookupScan').onclick=()=>openQrScanner(code=>{
      const el=document.getElementById('hwLookupCode'); if(el)el.value=code; lookupJack();
    });
    document.getElementById('hwPastJackOpen').onclick=openPastJack;
    document.getElementById('hwPendingNew').onclick=()=>openPendingEditor();
    document.getElementById('hwPendingDetails').addEventListener('toggle',e=>{if(e.target.open)renderPendingList();});

    const dailyMount=document.getElementById('seasonDailyExtraMount');
    if(dailyMount){
      dailyMount.innerHTML=`<div id="hwDailySheetsExtra" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
        <div style="font-weight:700;margin-bottom:4px;">🎃 Halloween · Jacks</div>
        <div class="hw-muted" style="line-height:1.45;">Estos respaldos sólo aparecen en canal Halloween.</div>
        <button class="btn-secondary btn-block" id="hwCopyJackRegistry" style="margin-top:8px;">🎃 Padrón actual → Halloween_Jacks</button>
        <button class="btn-secondary btn-block" id="hwAuditBtn" style="margin-top:6px;">🎃 Movimientos nuevos → Halloween_Movimientos</button>
        <button class="btn-secondary btn-block" id="hwAuditMarkBtn" style="margin-top:6px;display:none;">✓ Ya los pegué · marcar respaldados</button>
        <div id="hwBackupStatus" class="hw-muted" style="margin-top:8px;">Calculando respaldos…</div>
        <button class="btn-secondary btn-block" id="hwBackupBtn" style="margin-top:8px;">💾 Respaldo JSON completo Halloween</button>
      </div>`;
    }

    const mount=document.getElementById('hwOptionsMount');
    if(mount){
      mount.innerHTML=`<div id="hwOptionsSection" style="display:none;">
        <div class="section-title" style="margin-top:18px;">🎃 Halloween 2026</div>
        <details class="card" style="padding:12px;margin-bottom:8px;">
          <summary style="cursor:pointer;font-weight:700;">⚙️ Administración avanzada</summary>
          <div class="hw-muted" style="margin:8px 0;line-height:1.5;">Funciones poco frecuentes. Permanecen disponibles, pero cerradas para no llenar la pantalla durante la operación diaria.</div>

          <details id="hwInvDetails" class="card" style="padding:10px;margin:8px 0;">
            <summary style="cursor:pointer;font-weight:700;">🎴 Cartas e inventario</summary>
            <div class="hw-muted" style="margin-top:6px;">Configuración interna de las 17 cartas normales.</div>
            <div id="hwInventoryPanel" style="margin-top:8px;"></div>
          </details>

          <details class="card" style="padding:10px;margin:8px 0;">
            <summary style="cursor:pointer;font-weight:700;">📦 Lotes e impresión</summary>
            <div class="hw-muted" style="margin:8px 0;">El lote oficial ya existe. Genera otro únicamente si realmente necesitas una nueva tanda.</div>
            <div class="hw-line"><input id="hwBatchCount" type="number" min="1" value="50"><button class="btn-secondary" id="hwGenerateBatch">Generar lote Jack</button></div>
          </details>

          <details class="card" style="padding:10px;margin:8px 0;">
            <summary style="cursor:pointer;font-weight:700;">🛟 Recuperación / emergencia</summary>
            <div class="hw-muted" style="margin:8px 0;line-height:1.5;">No forma parte del cierre diario. Úsalo para recuperar o trasladar datos.</div>
            <button class="btn-secondary btn-block" id="hwRestoreBatch">↩️ Restaurar lote maestro de Jacks</button>
            <input id="hwRestoreBatchFile" type="file" accept="application/json,.json" style="display:none;">
            <button class="btn-secondary btn-block" id="hwRecoverJacks" style="margin-top:8px;">📋 Recuperar / copiar Jacks existentes</button>
            <button class="btn-secondary btn-block" id="hwImportBtn" style="margin-top:8px;">↩️ Importar JSON · fusionar sin borrar</button>
            <input id="hwImportFile" type="file" accept="application/json,.json" style="display:none;">
          </details>

          <details class="card" style="padding:10px;margin:8px 0;">
            <summary style="cursor:pointer;font-weight:700;">🧪 Pruebas y modo del sistema</summary>
            <div id="hwModeStatus" class="hw-muted" style="margin-top:8px;">Modo: calculando…</div>
            <button class="btn-secondary btn-block" id="hwModeToggle" style="margin-top:8px;">Cambiar modo</button>
            <div class="hw-muted" style="margin:8px 0;">Borra únicamente Halloween 2026 y los Jacks de prueba. No borra las ventas normales del ERP.</div>
            <button class="btn-secondary btn-block" id="hwResetTests" style="border-color:var(--danger);color:var(--danger);">Borrar temporada de prueba</button>
          </details>
        </details>
      </div>`;
      document.getElementById('hwGenerateBatch').onclick=generateBatch;
      document.getElementById('hwRestoreBatch').onclick=()=>document.getElementById('hwRestoreBatchFile').click();
      document.getElementById('hwRestoreBatchFile').onchange=restoreBatchMasterFile;
      document.getElementById('hwRecoverJacks').onclick=recoverExistingJacks;
      document.getElementById('hwModeToggle').onclick=toggleOperationalMode;
      document.getElementById('hwImportBtn').onclick=()=>document.getElementById('hwImportFile').click();
      document.getElementById('hwImportFile').onchange=importBackupFile;
      document.getElementById('hwInvDetails').addEventListener('toggle',e=>{ if(e.target.open)renderInventory(); });
      document.getElementById('hwResetTests').onclick=resetTestsUI;
    }
    document.getElementById('hwCopyJackRegistry')?.addEventListener('click',copyJackRegistry);
    document.getElementById('hwBackupBtn')?.addEventListener('click',downloadBackup);
    document.getElementById('hwAuditBtn')?.addEventListener('click',copyAudit);
    document.getElementById('hwAuditMarkBtn')?.addEventListener('click',markAuditCopied);
  }

  function isHalloweenChannel(){
    const v=document.getElementById('canalSelect')?.value||'';
    return String(v).trim().toLowerCase()==='halloween';
  }

  function updateHalloweenVisibility(){
    const on=isHalloweenChannel();
    const b=document.getElementById('btnHalloweenMode'); if(b){ b.style.display=on?'flex':'none'; if(!on)b.classList.remove('active'); }
    const opt=document.getElementById('hwOptionsSection'); if(opt)opt.style.display=on?'block':'none';
    const daily=document.getElementById('hwDailySheetsExtra'); if(daily)daily.style.display=on?'block':'none';
    if(on){ refreshBackupStatus(); refreshOperationalMode(); }
    if(!on){
      clearDashboardTransient(); clearSaleTransient(); stopQrScanner();
      const d=document.getElementById('hwDashboardOverlay'); if(d)d.style.display='none';
      const s=document.getElementById('hwSaleOverlay'); if(s)s.style.display='none';
      const dr=document.getElementById('hwDrawOverlay'); if(dr)dr.style.display='none';
      const al=document.getElementById('hwAlbumOverlay'); if(al)al.style.display='none'; UI.albumContext=null;
      const pj=document.getElementById('hwPastJackOverlay'); if(pj)pj.style.display='none';
      const pn=document.getElementById('hwPendingNoJackOverlay'); if(pn)pn.style.display='none'; UI.pendingEditingId=null;
    }
  }

  function renderWriterStatus(lock,recoveryCount=0){
    const st=document.getElementById('hwSystemStatus'); if(!st)return;
    if(lock?.ok){
      st.innerHTML='✅ Escritura Halloween activa'+(recoveryCount?` · <span class="hw-danger">${recoveryCount} operación(es) a revisar</span>`:'');
      return;
    }
    st.innerHTML='⚠️ Otra pestaña parece tener el control. <button type="button" class="btn-secondary" id="hwTakeWriter" style="padding:4px 8px;margin-left:5px;">Tomar control aquí</button>';
    document.getElementById('hwTakeWriter')?.addEventListener('click',async()=>{
      if(!confirm('Usa esto sólo si esta es la pestaña que vas a usar para vender. Si hay otra pestaña Halloween abierta, ciérrala.\n\n¿Tomar control de escritura aquí?'))return;
      const got=await Core.acquireWriterLock({force:true});
      renderWriterStatus(got,0);
      showMsg('Control de Halloween tomado en esta pestaña');
    });
  }

  function deleteIndexedDb(name){
    return new Promise((resolve,reject)=>{
      const r=indexedDB.deleteDatabase(name);
      r.onsuccess=()=>resolve(true);
      r.onerror=()=>reject(r.error||new Error('No se pudo borrar '+name));
      r.onblocked=()=>reject(new Error('El borrado de '+name+' quedó bloqueado por otra pestaña abierta. Cierra otras pestañas del ERP y vuelve a intentar.'));
    });
  }

  async function performPendingHardReset(){
    const key='hw2026_pending_hard_reset';
    let pending=null;
    try{ pending=JSON.parse(localStorage.getItem(key)||'null'); }catch(_){ pending=null; }
    if(!pending) return null;
    // En esta recarga todavía NO se han abierto las bases de Halloween/Folios,
    // así que podemos eliminarlas de raíz sin competir con conexiones vivas.
    await deleteIndexedDb(DB_NAME);
    await deleteIndexedDb('folios_HW2026');
    try{ localStorage.removeItem('hw2026_writer_lock'); }catch(_){}
    try{ sessionStorage.removeItem('hw2026_tab_id'); }catch(_){}
    try{ localStorage.removeItem(key); }catch(_){}
    return pending;
  }

  async function initUI(){
    try{
      const resetDone=await performPendingHardReset();
      injectStyles(); injectUI();
      await Core.init();
      await Folios.init({prefijo:config.prefijo,niveles:LEVELS});
      const lock=await Core.acquireWriterLock();
      const rec=await Core.reconcileOps();
      UI.initialized=true;
      renderWriterStatus(lock,rec.length);
      updateHalloweenVisibility();
      if(resetDone){
        setTimeout(()=>alert(`Temporada de PRUEBA borrada por completo.\nJacks eliminados: ${Number(resetDone.jacks||0)}.\n\nLa base Halloween y la base de códigos Jack fueron creadas de nuevo desde cero.`),120);
      }
      await syncTodaySales();
      document.getElementById('canalSelect')?.addEventListener('change',updateHalloweenVisibility);
      document.addEventListener('rv:session-changed',updateHalloweenVisibility);
      document.addEventListener('rv:sale-completed',async ev=>{
        const sessionCanal=String(ev.detail?.sessionCanal||ev.detail?.canal||'').trim().toLowerCase();
        if(sessionCanal!=='halloween') return;
        try{ const sale=await Core.captureSale(ev.detail); openSale(sale); }
        catch(e){ alert('Halloween no pudo registrar la venta: '+e.message); }
      });
    }catch(e){
      console.error(e); const st=document.getElementById('hwSystemStatus'); if(st)st.innerHTML='<span class="hw-danger">Halloween no inició: '+escapeHtml(e.message)+'</span>';
      alert('⚠️ Modo Halloween no pudo iniciar. Las ventas normales siguen funcionando.\n\n'+e.message);
    }
  }

  async function syncTodaySales(){
    try{
      if(typeof todaySales==='undefined') return;
      const grouped=new Map();
      for(const s of todaySales){ if(!s.ventaId)continue; if(String(s.canal||'').trim().toLowerCase()!=='halloween')continue; if(!grouped.has(s.ventaId))grouped.set(s.ventaId,[]);grouped.get(s.ventaId).push(s); }
      for(const [ventaId,items] of grouped){
        const total=items.reduce((a,x)=>a+Number(x.total||0),0);
        await Core.captureSale({ventaId,total,items,fecha:items[0]?.fecha,canal:items[0]?.canal,vendedor:items[0]?.socio});
      }
    }catch(e){console.warn('syncTodaySales',e);}
  }

  function escapeHtml(v){ const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML; }
  function showMsg(msg){ if(typeof showToast==='function')showToast(msg); else alert(msg); }
  function emitHalloweenEvent(type,detail={}){ document.dispatchEvent(new CustomEvent('hw:event',{detail:{type,fecha:new Date().toISOString(),...detail}})); }
  function emitSaleFinalizedOnce(ventaId,detail={}){
    const id=String(ventaId||''); if(!id||UI.finalizedSales.has(id))return;
    UI.finalizedSales.add(id); emitHalloweenEvent('venta_finalizada',{ventaId:id,...detail});
  }

  function clearSaleTransient(){
    UI.noJackConfirmUntil=0; clearTimeout(UI.noJackTimer); UI.noJackTimer=null;
    const code=document.getElementById('hwSaleCode'); if(code)code.value='';
    const status=document.getElementById('hwSaleCodeStatus'); if(status){status.textContent='Escribe o escanea el código; el sistema detecta si es nuevo o activo.';status.className='hw-muted';}
    stopQrScanner();
  }
  function clearDashboardTransient(){
    UI.currentJack=null;
    const code=document.getElementById('hwLookupCode'); if(code)code.value='';
    const panel=document.getElementById('hwJackPanel'); if(panel)panel.innerHTML='';
    const al=document.getElementById('hwAlbumOverlay'); if(al)al.style.display='none'; UI.albumContext=null;
    stopQrScanner();
  }

  function parseJackQr(raw){
    // Tolerante a espacios, guiones tipográficos y texto alrededor; la existencia real
    // del Jack se valida después contra Folios. Evita rechazar un QR bueno por formato.
    const txt=String(raw||'').trim().toUpperCase().replace(/[–—−]/g,'-');
    const prefix=String(config.prefijo||'H26').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const re=new RegExp(prefix+'[\\s\\-_:]*([A-Z0-9]{4,20})');
    const m=txt.match(re); return m?normalizeCode(prefix+'-'+m[1]):null;
  }
  function stopQrScanner(){
    const st=UI.scanner;
    if(st?.raf) cancelAnimationFrame(st.raf);
    if(st?.stream) st.stream.getTracks().forEach(t=>t.stop());
    UI.scanner=null;
    const video=document.getElementById('hwQrVideo'); if(video){try{video.pause();}catch(_){} video.srcObject=null;}
    const ov=document.getElementById('hwQrOverlay'); if(ov)ov.style.display='none';
  }
  async function openQrScanner(onCode){
    stopQrScanner();
    if(!navigator.mediaDevices?.getUserMedia){ alert('Este navegador no permite usar la cámara desde el HTML. Puedes escribir el código Jack manualmente.'); return; }
    if(!('BarcodeDetector' in root)){ alert('Este navegador no tiene lector QR nativo. El código manual sigue funcionando. Prueba Chrome actualizado en Android.'); return; }
    const ov=document.getElementById('hwQrOverlay'), video=document.getElementById('hwQrVideo'), status=document.getElementById('hwQrStatus');
    try{
      const formats=root.BarcodeDetector.getSupportedFormats?await root.BarcodeDetector.getSupportedFormats():['qr_code'];
      if(formats?.length&&!formats.includes('qr_code')) throw new Error('El navegador no reporta soporte para QR');
      const detector=new root.BarcodeDetector({formats:['qr_code']});
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
      UI.scanner={stream,detector,onCode,busy:false,raf:null};
      video.srcObject=stream; ov.style.display='flex'; ov.style.zIndex='10000'; status.textContent='Apunta al QR del Jack.';
      await video.play();
      let lastTry=0;
      const loop=async(ts)=>{
        const st=UI.scanner; if(!st)return;
        if(!st.busy&&video.readyState>=2&&ts-lastTry>160){
          lastTry=ts; st.busy=true;
          try{
            const found=await detector.detect(video);
            if(found?.length){
              const code=parseJackQr(found[0].rawValue||found[0].rawValueText||'');
              if(code){
                const valid=await Folios.validar(code);
                if(valid?.existe){
                  const cb=st.onCode; stopQrScanner(); if(navigator.vibrate)navigator.vibrate(45); cb?.(code); return;
                }
                status.textContent='QR leído: '+code+' · ese código no está registrado en esta base. Sigue apuntando o cancela.';
              }else{
                status.textContent='Ese QR no contiene un código Jack reconocible. Sigue apuntando al código correcto.';
              }
            }
          }catch(_){}
          finally{if(UI.scanner)UI.scanner.busy=false;}
        }
        if(UI.scanner)UI.scanner.raf=requestAnimationFrame(loop);
      };
      UI.scanner.raf=requestAnimationFrame(loop);
    }catch(e){
      stopQrScanner(); alert('No se pudo abrir el escáner QR: '+e.message+'\\n\\nPuedes escribir el código manualmente.');
    }
  }
  root.HalloweenQR=Object.freeze({scan:openQrScanner,stop:stopQrScanner,parse:parseJackQr});

  async function openSale(sale){
    UI.currentSale=await Core.getSale(sale.ventaId);
    const ov=document.getElementById('hwSaleOverlay'); ov.style.display='flex'; await renderSaleBody();
  }

  async function renderSaleBody(){
    const s=UI.currentSale=await Core.getSale(UI.currentSale.ventaId); const body=document.getElementById('hwSaleBody');
    const rows=s.allocations.map(a=>`<div class="sale-row"><div><b>${escapeHtml(a.codigo)}</b><div class="sale-meta">${a.nuevo?'Jack activado':'Compra sumada'}</div></div><div class="sale-amount">${money(a.monto)}</div></div>`).join('');
    const itemSummary=(s.items||[]).map(x=>`${escapeHtml(x.nombre)} ×${x.cantidad}`).join(' · ');
    body.innerHTML=`
      <div class="total-line"><span>Venta</span><strong>${money(s.total)}</strong></div>
      ${itemSummary?`<div class="hw-muted">${itemSummary}</div>`:''}
      ${rows||''}
      <div class="total-line"><span>Queda por aplicar</span><strong>${money(s.unallocated)}</strong></div>
      ${s.unallocated>0?`<div class="hw-section">
        <div class="field"><label>Código Jack</label><div class="hw-line"><input id="hwSaleCode" type="text" placeholder="H26-XXXXXX" autocomplete="off"><button class="btn-secondary hw-scan-btn" id="hwSaleScan" type="button" title="Escanear QR">📷</button></div><div id="hwSaleCodeStatus" class="hw-muted" style="min-height:18px;margin-top:4px;">Escribe o escanea el código; el sistema detecta si es nuevo o activo.</div></div>
        <div class="field" style="margin-top:8px;"><label>Monto para este Jack</label><input id="hwSaleAmount" type="number" min="0.01" step="0.01" value="${Number(s.unallocated).toFixed(2)}"></div>
        <div class="field" style="margin-top:8px;"><label>Nota del Jack / nombre / recordatorio (opcional)</label><input id="hwSaleNote" type="text" maxlength="500" placeholder="Ej. vecino del 4º · recoger cartas después"></div>
        <button class="btn-primary" id="hwApplyJack">Aplicar a Jack</button>
        <button class="btn-secondary btn-block" id="hwNoJack" style="margin-top:8px;">Terminar sin aplicar a Jack</button>
        <div class="hw-muted" style="margin-top:8px;">Si una compra se reparte entre varios Jacks, aplica una parte y repite. Nunca podrá superar el total cobrado.</div>
      </div>`:`<div class="hw-ok" style="margin-top:10px;">✓ Venta completamente aplicada.</div>`}`;
    if(s.unallocated>0){
      document.getElementById('hwApplyJack').onclick=applySaleJack;
      document.getElementById('hwNoJack').onclick=noJackSale;
      document.getElementById('hwSaleScan').onclick=()=>openQrScanner(code=>{
        const el=document.getElementById('hwSaleCode'); if(!el)return; el.value=code; el.dispatchEvent(new Event('input',{bubbles:true}));
      });
      let t=null; document.getElementById('hwSaleCode').addEventListener('input',()=>{ clearTimeout(t); t=setTimeout(updateSaleCodeStatus,180); });
    }
  }

  async function updateSaleCodeStatus(){
    const el=document.getElementById('hwSaleCode'); const st=document.getElementById('hwSaleCodeStatus'); if(!el||!st)return;
    const code=normalizeCode(el.value); if(code.length<5){ st.textContent='Escribe el código; el sistema detecta si es nuevo o activo.'; st.className='hw-muted'; return; }
    try{
      const v=await Folios.validar(code);
      if(!v.existe){ st.textContent='Código no encontrado en los Jacks impresos.'; st.className='hw-danger'; return; }
      if(v.estado==='impresa'){ st.textContent=`Jack nuevo · requiere mínimo ${money(config.compraMinJack)} para activarse.`; st.className='hw-ok'; }
      else if(v.estado==='entregada'){ st.textContent=`Jack activo · acumulado actual ${money(v.acumulado)}.`; st.className='hw-ok'; }
      else { st.textContent=`Jack en estado: ${v.estado}.`; st.className='hw-danger'; }
    }catch(e){ st.textContent=e.message; st.className='hw-danger'; }
  }

  async function applySaleJack(){
    try{
      const code=document.getElementById('hwSaleCode').value; const amount=Number(document.getElementById('hwSaleAmount').value);
      const note=String(document.getElementById('hwSaleNote')?.value||'').trim();
      const out=await Core.applyAllocation({ventaId:UI.currentSale.ventaId,codigo:code,monto:amount}); UI.currentSale=out.sale;
      if(note) await Core.saveJackNote(code,note);
      emitHalloweenEvent(out.nuevo?'jack_nuevo':'compra_jack',{codigo:normalizeCode(code),monto:amount,acumulado:out.result.acumulado,nivel:out.result.nivel,ventaId:UI.currentSale.ventaId});
      if(out.nivelAntes!==out.nivelDespues && out.nivelDespues) emitHalloweenEvent('subio_nivel',{codigo:normalizeCode(code),antes:out.nivelAntes,despues:out.nivelDespues,acumulado:out.result.acumulado,ventaId:UI.currentSale.ventaId});
      const saleComplete=Number(out.sale?.unallocated||0)<=0.0001;
      if(out.cardsOwed>0) await openDraw({codigo:normalizeCode(code),ventaId:UI.currentSale.ventaId,count:out.cardsOwed,anonymous:false,finalizeSale:saleComplete});
      else if(saleComplete) emitSaleFinalizedOnce(UI.currentSale.ventaId,{codigo:normalizeCode(code),conJack:true});
      await renderSaleBody();
      showMsg(out.nuevo?'Jack activado':'Compra sumada a Jack');
    }catch(e){ alert(e.message); }
  }

  async function noJackSale(){
    const btn=document.getElementById('hwNoJack'); if(!btn)return;
    const now=Date.now();
    if(now>UI.noJackConfirmUntil){
      UI.noJackConfirmUntil=now+4000;
      btn.textContent='⚠ CONFIRMAR: VENTA SIN JACK';
      btn.style.borderColor='var(--danger)'; btn.style.color='var(--danger)';
      clearTimeout(UI.noJackTimer); UI.noJackTimer=setTimeout(()=>{ UI.noJackConfirmUntil=0; if(document.getElementById('hwNoJack')){document.getElementById('hwNoJack').textContent='Terminar sin aplicar a Jack';document.getElementById('hwNoJack').style.borderColor='';document.getElementById('hwNoJack').style.color='';}},4100);
      return;
    }
    UI.noJackConfirmUntil=0; clearTimeout(UI.noJackTimer);
    try{
      const out=await Core.closeSaleWithoutJack(UI.currentSale.ventaId); UI.currentSale=out.sale;
      document.getElementById('hwSaleOverlay').style.display='none'; emitSaleFinalizedOnce(UI.currentSale.ventaId,{conJack:false}); showMsg('Venta normal · sin Jack');
    }catch(e){alert(e.message);}
  }

  async function openDraw(ctx){
    UI.drawContext=ctx; UI.selectedCards=[];
    document.getElementById('hwDrawIntro').textContent=`Que el cliente saque ${ctx.count} carta(s) de la urna. Luego toca aquí exactamente las que salieron.`;
    document.getElementById('hwDrawCount').textContent=`0/${ctx.count}`;
    const inv=await Core.listInventory(); const grid=document.getElementById('hwCardGrid'); grid.innerHTML='';
    for(const c of inv){
      const b=document.createElement('button'); b.className='hw-cardpick'; b.type='button'; b.dataset.id=c.id;
      b.innerHTML=`<b>${escapeHtml(c.numero||c.id)} · ${escapeHtml(c.nombre)}</b><small>${c.rareza}${c.stock===null?'':' · stock '+c.stock}</small><span class="hw-count" style="display:none;">0</span>`;
      bindCardPickerButton(c.id,b); grid.appendChild(b);
    }
    document.getElementById('hwDrawOverlay').style.display='flex';
  }

  function updateCardPickVisual(id,btn){
    const n=UI.selectedCards.filter(x=>x===id).length; const badge=btn.querySelector('.hw-count');
    btn.classList.toggle('sel',n>0); badge.style.display=n>0?'block':'none'; badge.textContent=String(n);
    document.getElementById('hwDrawCount').textContent=`${UI.selectedCards.length}/${UI.drawContext?.count||0}`;
  }
  function pickCard(id,btn){
    const need=UI.drawContext.count; if(UI.selectedCards.length>=need){ showMsg('Ya seleccionaste todas'); return; }
    UI.selectedCards.push(id); updateCardPickVisual(id,btn);
  }
  function unpickCard(id,btn){
    const idx=UI.selectedCards.lastIndexOf(id); if(idx<0){ showMsg('Esa carta está en 0'); return; }
    UI.selectedCards.splice(idx,1); updateCardPickVisual(id,btn);
  }
  function bindCardPickerButton(id,btn){
    let timer=null,startX=0,startY=0,moved=false,longDone=false;
    const clear=()=>{if(timer){clearTimeout(timer);timer=null;}};
    btn.addEventListener('pointerdown',e=>{
      startX=e.clientX; startY=e.clientY; moved=false; longDone=false; clear();
      timer=setTimeout(()=>{timer=null;if(moved)return;longDone=true;unpickCard(id,btn);if(navigator.vibrate)navigator.vibrate(30);},650);
    });
    btn.addEventListener('pointermove',e=>{if(Math.abs(e.clientX-startX)>9||Math.abs(e.clientY-startY)>9){moved=true;clear();}});
    btn.addEventListener('pointerup',e=>{clear();if(!moved&&!longDone)pickCard(id,btn);e.preventDefault();});
    btn.addEventListener('pointercancel',clear);
    btn.addEventListener('pointerleave',clear);
    btn.addEventListener('contextmenu',e=>e.preventDefault());
  }

  async function confirmDraw(){
    const ctx=UI.drawContext; if(!ctx)return; if(UI.selectedCards.length!==ctx.count){showMsg(`Faltan ${ctx.count-UI.selectedCards.length} por registrar`);return;}
    try{ await Core.registerDraw({...ctx,cardIds:UI.selectedCards,source:'gratis'}); emitHalloweenEvent('cartas_entregadas',{codigo:ctx.codigo||null,ventaId:ctx.ventaId||null,cantidad:UI.selectedCards.length,cardIds:[...UI.selectedCards]}); document.getElementById('hwDrawOverlay').style.display='none'; UI.drawContext=null; UI.selectedCards=[]; if(ctx.finalizeSale&&ctx.ventaId)emitSaleFinalizedOnce(ctx.ventaId,{codigo:ctx.codigo||null,conJack:!!ctx.codigo}); showMsg('Cartas registradas'); }
    catch(e){alert(e.message);}
  }

  async function confirmQuickDraw(){
    const ctx=UI.drawContext; if(!ctx)return;
    if(!confirm(`¿Confirmar que entregaste ${ctx.count} carta(s) sin registrar cuáles? Se contará la entrega, pero no actualizará inventario por diseño.`))return;
    try{ await Core.registerQuickCards({...ctx,count:ctx.count,source:'gratis'}); emitHalloweenEvent('cartas_entregadas_rapido',{codigo:ctx.codigo||null,ventaId:ctx.ventaId||null,cantidad:ctx.count}); document.getElementById('hwDrawOverlay').style.display='none'; UI.drawContext=null; UI.selectedCards=[]; if(ctx.finalizeSale&&ctx.ventaId)emitSaleFinalizedOnce(ctx.ventaId,{codigo:ctx.codigo||null,conJack:!!ctx.codigo}); showMsg('Entrega rápida registrada'); }
    catch(e){alert(e.message);}
  }

  async function openDashboard(){
    if(!isHalloweenChannel())return; document.getElementById('btnHalloweenMode')?.classList.add('active'); document.getElementById('hwDashboardOverlay').style.display='flex'; await Promise.all([refreshStats(),renderPendingList()]);
  }

  async function refreshStats(){
    try{ const s=await Core.summary(); document.getElementById('hwStats').innerHTML=`
      <div class="hw-stat"><b>${s.jacksActivos}</b><span>Jacks</span></div><div class="hw-stat"><b>${money(s.acumuladoTotal)}</b><span>acumulado</span></div><div class="hw-stat"><b>${s.eventos}</b><span>movimientos</span></div>`; }
    catch(e){console.error(e);}
  }

  async function renderInventory(){
    const inv=await Core.listInventory(); const p=document.getElementById('hwInventoryPanel'); p.innerHTML='';
    for(const c of inv){
      const row=document.createElement('div'); row.className='price-row'; row.style.flexWrap='wrap'; row.innerHTML=`
        <span class="pname"><b>${escapeHtml(c.id)}</b> <small>(${c.rareza}, peso ${c.peso})</small></span>
        <input data-id="${c.id}" class="hw-num" type="text" placeholder="#" value="${escapeHtml(c.numero||'')}" style="width:52px;padding:7px;">
        <input data-id="${c.id}" class="hw-stock" type="number" min="0" placeholder="stock ?" value="${c.stock===null?'':c.stock}" style="width:78px;padding:7px;">
        <input data-id="${c.id}" class="hw-name" type="text" value="${escapeHtml(c.nombre)}" style="width:100%;padding:7px;margin-top:5px;">`;
      p.appendChild(row);
    }
    const save=document.createElement('button');save.className='btn-secondary btn-block';save.textContent='Guardar catálogo / existencias';save.style.marginTop='8px';save.onclick=async()=>{
      for(const el of p.querySelectorAll('.hw-stock')){
        const id=el.dataset.id; const num=p.querySelector(`.hw-num[data-id="${id}"]`).value; const name=p.querySelector(`.hw-name[data-id="${id}"]`).value;
        await Core.setInventory(id,el.value,num,name);
      }
      showMsg('Catálogo e inventario guardados');await renderInventory();
    };p.appendChild(save);
  }

  function bindHoldButton(btn,ms,action){
    if(!btn)return;
    let timer=null,moved=false,startX=0,startY=0,done=false;
    const clear=()=>{if(timer){clearTimeout(timer);timer=null;}};
    btn.addEventListener('pointerdown',e=>{
      moved=false;done=false;startX=e.clientX;startY=e.clientY;clear();
      timer=setTimeout(async()=>{timer=null;if(moved||done)return;done=true;if(navigator.vibrate)navigator.vibrate(35);try{await action();}catch(err){alert(err.message||String(err));}},ms);
    });
    btn.addEventListener('pointermove',e=>{if(Math.abs(e.clientX-startX)>10||Math.abs(e.clientY-startY)>10){moved=true;clear();}});
    btn.addEventListener('pointerup',clear);btn.addEventListener('pointercancel',clear);btn.addEventListener('pointerleave',clear);btn.addEventListener('contextmenu',e=>e.preventDefault());
  }

  function openPastJack(){
    const ov=document.getElementById('hwPastJackOverlay'); if(!ov)return;
    document.getElementById('hwPastJackCode').value='';
    document.getElementById('hwPastJackAmount').value='';
    document.getElementById('hwPastJackNote').value='';
    const d=document.getElementById('hwPastJackDate'); if(d){const n=new Date(),pad=x=>String(x).padStart(2,'0');d.value=`${n.getFullYear()}-${pad(n.getMonth()+1)}-${pad(n.getDate())}`;}
    ov.style.display='flex';
  }
  function closePastJack(){ const ov=document.getElementById('hwPastJackOverlay'); if(ov)ov.style.display='none'; }
  async function savePastJack(){
    const btn=document.getElementById('hwPastJackSave'); if(!btn||btn.disabled)return;
    const codigo=document.getElementById('hwPastJackCode')?.value||'';
    const monto=Number(document.getElementById('hwPastJackAmount')?.value);
    const fechaVenta=document.getElementById('hwPastJackDate')?.value||'';
    const nota=document.getElementById('hwPastJackNote')?.value||'';
    if(!normalizeCode(codigo)){alert('Escribe o escanea el código Jack.');return;}
    if(!Number.isFinite(monto)||monto<=0){alert('Escribe el monto real de aquella compra.');return;}
    if(!fechaVenta){alert('Selecciona la fecha de aquella compra.');return;}
    if(!confirm(`REGISTRAR COMPRA PASADA\n\nJack: ${normalizeCode(codigo)}\nMonto: ${money(monto)}\nFecha: ${fechaVenta}\n\nEsto NO crea otra venta en el ERP; sólo corrige el Jack y deja las cartas no entregadas como pendientes. ¿Continuar?`))return;
    btn.disabled=true; const prev=btn.textContent; btn.textContent='Registrando…';
    try{
      const out=await Core.registerPastJack({codigo,monto,fechaVenta,nota});
      closePastJack();
      const lookup=document.getElementById('hwLookupCode'); if(lookup)lookup.value=normalizeCode(codigo);
      await lookupJack(); await refreshStats(); await refreshBackupStatus();
      emitHalloweenEvent(out.nuevo?'jack_nuevo':'compra_jack',{codigo:normalizeCode(codigo),monto,acumulado:out.result.acumulado,nivel:out.result.nivel,retroactivo:true});
      if(out.nivelAntes!==out.nivelDespues && out.nivelDespues) emitHalloweenEvent('subio_nivel',{codigo:normalizeCode(codigo),antes:out.nivelAntes,despues:out.nivelDespues,acumulado:out.result.acumulado,retroactivo:true});
      alert(`Jack actualizado.\n\nAcumulado: ${money(out.result.acumulado)}\nNivel: ${out.result.nivel||'sin nivel'}\nCartas pendientes: ${out.cardsOwed}\n\nCuando vuelva el cliente, búscalo y usa “Entregar sobres pendientes”.`);
    }catch(e){alert(e.message);}
    finally{btn.disabled=false;btn.textContent=prev;}
  }

  async function openPendingEditor(id=null){
    UI.pendingEditingId=id?String(id):null;
    const rec=id?await Core.getPendingNoJack(id):null;
    document.getElementById('hwPendingAlias').value=rec?.alias||'';
    document.getElementById('hwPendingAmount').value=Number(rec?.acumulado||0).toFixed(2);
    document.getElementById('hwPendingCards').value=String(Number(rec?.cartasEntregadas||0));
    document.getElementById('hwPendingNote').value=rec?.nota||'';
    document.getElementById('hwPendingNoJackOverlay').style.display='flex';
  }
  function closePendingEditor(){UI.pendingEditingId=null;const ov=document.getElementById('hwPendingNoJackOverlay');if(ov)ov.style.display='none';}
  async function savePendingEditor(){
    const btn=document.getElementById('hwPendingSave');if(!btn||btn.disabled)return;
    const alias=document.getElementById('hwPendingAlias')?.value||'',acumulado=Number(document.getElementById('hwPendingAmount')?.value),cartasEntregadas=Number(document.getElementById('hwPendingCards')?.value),nota=document.getElementById('hwPendingNote')?.value||'';
    btn.disabled=true;const prev=btn.textContent;btn.textContent='Guardando…';
    try{await Core.savePendingNoJack({id:UI.pendingEditingId,alias,acumulado,cartasEntregadas,nota});closePendingEditor();await renderPendingList();await refreshStats();await refreshBackupStatus();showMsg('Acumulación sin Jack guardada');}
    catch(e){alert(e.message);}
    finally{btn.disabled=false;btn.textContent=prev;}
  }
  async function convertPendingUI(id){
    const rec=await Core.getPendingNoJack(id);if(!rec)return;
    if(Number(rec.acumulado||0)<Number(config.compraMinJack||50)){alert(`Todavía lleva ${money(rec.acumulado)}. El Jack se activa al llegar a ${money(config.compraMinJack)}.`);return;}
    const codigo=prompt(`CONVERTIR A JACK\n\n${rec.alias}\nAcumulado: ${money(rec.acumulado)}\nCartas ya entregadas: ${rec.cartasEntregadas}\n\nEscribe el código del Jack impreso:`,'');
    if(codigo===null)return;
    if(!confirm(`¿Convertir "${rec.alias}" a ${normalizeCode(codigo)}?\n\nSe transferirá ${money(rec.acumulado)} y se respetarán ${rec.cartasEntregadas} carta(s) ya entregadas.`))return;
    try{
      const out=await Core.convertPendingNoJack(id,codigo);
      await renderPendingList();await refreshStats();await refreshBackupStatus();
      const lookup=document.getElementById('hwLookupCode');if(lookup)lookup.value=out.snapshot.codigo;await lookupJack();
      alert(`Jack activado.\n\nAcumulado: ${money(out.snapshot.acumulado)}\nNivel: ${out.snapshot.nivel||'sin nivel'}\nCartas pendientes: ${out.cardsOwed}`);
    }catch(e){alert(e.message);}
  }
  async function closePendingUI(id){
    const rec=await Core.getPendingNoJack(id);if(!rec)return;
    if(!confirm(`Cerrar la acumulación de "${rec.alias}"?\n\nNo crea Jack. El registro queda en historial y en el respaldo JSON.`))return;
    try{await Core.closePendingNoJack(id);await renderPendingList();await refreshStats();await refreshBackupStatus();showMsg('Acumulación cerrada');}catch(e){alert(e.message);}
  }
  async function renderPendingList(){
    const host=document.getElementById('hwPendingList');if(!host)return;
    const rows=await Core.listPendingNoJack({includeClosed:true}),pending=rows.filter(x=>x.estado==='pendiente'),history=rows.filter(x=>x.estado!=='pendiente');
    const count=document.getElementById('hwPendingCount');if(count)count.textContent=pending.length?`(${pending.length})`:'';
    const rowHtml=r=>{
      const earned=Math.floor(Number(r.acumulado||0)/Number(config.cartaCada||25)),canConvert=r.estado==='pendiente'&&Number(r.acumulado||0)>=Number(config.compraMinJack||50);
      const status=r.estado==='pendiente'?'Pendiente':r.estado==='convertido'?`Convertido · ${escapeHtml(r.codigo||'')}`:'Cerrado';
      const actions=r.estado==='pendiente'?`<div class="hw-line" style="margin-top:7px;"><button class="btn-secondary" data-pending-edit="${r.id}">Editar</button><button class="btn-secondary" data-pending-convert="${r.id}" ${canConvert?'':'disabled'}>→ Jack</button><button class="btn-secondary" data-pending-close="${r.id}">Cerrar</button></div>`:'';
      return `<div class="card hw-card" style="padding:9px;margin-top:7px;"><div style="display:flex;justify-content:space-between;gap:8px;"><b>${escapeHtml(r.alias)}</b><span class="hw-pill">${status}</span></div><div class="total-line"><span>Acumulado</span><strong>${money(r.acumulado)}</strong></div><div class="total-line"><span>Cartas entregadas / ganadas</span><strong>${Number(r.cartasEntregadas||0)}/${earned}</strong></div>${r.nota?`<div class="hw-muted">${escapeHtml(r.nota)}</div>`:''}${actions}</div>`;
    };
    host.innerHTML=(pending.map(rowHtml).join('')||'<div class="hw-muted">No hay acumulaciones sin Jack pendientes.</div>')+(history.length?`<details style="margin-top:8px;"><summary style="cursor:pointer;font-weight:700;">Historial (${history.length})</summary>${history.map(rowHtml).join('')}</details>`:'');
    host.querySelectorAll('[data-pending-edit]').forEach(b=>b.onclick=()=>openPendingEditor(b.dataset.pendingEdit));
    host.querySelectorAll('[data-pending-convert]').forEach(b=>b.onclick=()=>convertPendingUI(b.dataset.pendingConvert));
    host.querySelectorAll('[data-pending-close]').forEach(b=>b.onclick=()=>closePendingUI(b.dataset.pendingClose));
  }

  async function lookupJack(){
    const code=document.getElementById('hwLookupCode').value;
    try{
      const s=await Core.jackSnapshot(code); const p=document.getElementById('hwJackPanel');
      if(!s.existe){p.innerHTML='<div class="hw-danger" style="margin-top:8px;">Jack no encontrado.</div>';return;}
      UI.currentJack=s.codigo;
      const unique=[...new Set((s.profile.cardHistory||[]).map(x=>x.id).filter(Boolean))];
      const [sales,jackEvents]=await Promise.all([Core.getJackSales(s.codigo),Core.getJackEvents(s.codigo)]);
      const salesHtml=sales.length?`<details style="margin-top:10px;"><summary style="cursor:pointer;font-weight:700;">Compras registradas (${sales.length})</summary>
        <div style="margin-top:6px;">${sales.map(x=>{
          const items=(x.items||[]).map(i=>`<div class="sale-meta">${escapeHtml(i.nombre)} · ${i.cantidad} × ${money(i.precio)} = ${money(i.total)}</div>`).join('')||'<div class="sale-meta">Detalle de productos no disponible en esta venta antigua.</div>';
          return `<div style="padding:8px 0;border-bottom:1px solid var(--border);"><div style="display:flex;justify-content:space-between;gap:8px;"><b>${escapeHtml(x.fecha||x.createdAt||'')}</b><b>+${money(x.aplicado)}</b></div>${items}<div class="hw-muted">Cuenta completa: ${money(x.total)} · ${escapeHtml(x.ventaId)}</div></div>`;
        }).join('')}</div></details>`:'';
      const retroEvents=jackEvents.filter(e=>e.tipo==='compra_pasada_jack');
      const retroHtml=retroEvents.length?`<details style="margin-top:8px;"><summary style="cursor:pointer;font-weight:700;">Compras pasadas / ajustes (${retroEvents.length})</summary><div style="margin-top:6px;">${retroEvents.map(e=>`<div style="padding:7px 0;border-bottom:1px solid var(--border);"><div style="display:flex;justify-content:space-between;gap:8px;"><b>${escapeHtml(niceDate(e.fecha))}</b><b>+${money(e.monto)}</b></div>${e.nota?`<div class="hw-muted">${escapeHtml(e.nota)}</div>`:''}</div>`).join('')}</div></details>`:'';

      const pendingBlock=s.freePending>0
        ? `<button class="btn-secondary btn-block" id="hwDeliverPending" style="margin-top:10px;">🎴 Entregar sobres pendientes (${s.freePending})</button>`
        : `<div class="total-line"><span>Sobres pendientes</span><strong class="hw-ok">✅ 0</strong></div>`;

      const catrinaBlock=s.profile.catrina
        ? `<div class="total-line"><span>Catrina</span><strong class="hw-ok">✅ Entregada</strong></div>
           <button class="btn-secondary btn-block" id="hwCatrinaUndo" style="margin-top:6px;font-size:12px;opacity:.82;">Mantén presionado para corregir Catrina</button>`
        : `<div class="total-line"><span>Catrina</span><strong>Pendiente</strong></div>
           <button class="btn-secondary btn-block" id="hwCatrinaMark" style="margin-top:6px;">Confirmar entrega de Catrina</button>`;

      const redeemed=s.estado==='canjeada';
      const redeemBlock=redeemed
        ? `<div class="hw-section"><div style="font-weight:800;font-size:15px;" class="hw-ok">✅ CANJE FINAL REALIZADO</div>
           <div class="total-line"><span>Bolo</span><strong>${escapeHtml(s.nivel||'sin nivel')}</strong></div>
           <div class="total-line"><span>Charro Negro</span><strong class="hw-ok">${s.profile.charro?'✅ Entregado':'✅ Registrado con canje'}</strong></div>
           <div class="total-line"><span>Jack físico</span><strong class="hw-ok">✅ Presentado</strong></div>
           <div class="hw-muted">${escapeHtml(niceDate(s.fechas?.canjeada))}</div></div>`
        : `<div class="hw-section"><div class="field-row"><input type="checkbox" id="hwPhysical"><label for="hwPhysical" style="font-size:13px;color:var(--text);">Jack físico presentado</label></div>
           <button class="btn-primary" id="hwRedeem">Canje final: bolo + Charro</button></div>`;

      p.innerHTML=`<div class="card hw-card" style="margin-top:10px;"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><b>${escapeHtml(s.codigo)}</b><span class="hw-pill">${escapeHtml(s.estado)}</span></div>
        <div class="total-line"><span>Acumulado</span><strong>${money(s.acumulado)}</strong></div>
        <div class="total-line"><span>Nivel</span><strong>${escapeHtml(s.nivel||'sin nivel')}</strong></div>
        <div class="total-line"><span>Sobres/cartas entregadas</span><strong>${s.profile.freeDelivered}/${s.freeEarned}</strong></div>
        ${pendingBlock}
        <div class="hw-section">${catrinaBlock}</div>
        ${redeemBlock}
        <div class="hw-muted" style="margin-top:10px;">Diseños registrados por el puesto: ${unique.length}/17. El álbum físico manda después de intercambios.</div>
        ${salesHtml}
        ${retroHtml}
        <div class="hw-section"><div class="field"><label>Nota / nombre / recordatorio</label><textarea id="hwJackNote" maxlength="500" rows="3" placeholder="Sin nota">${escapeHtml(s.profile.nota||'')}</textarea></div><button class="btn-secondary btn-block" id="hwSaveJackNote" style="margin-top:6px;">Guardar nota</button></div>
        <button class="btn-secondary btn-block" id="hwAlbumState" style="margin-top:8px;">Actualizar cartas que dice tener ahora</button>
      </div>`;

      document.getElementById('hwDeliverPending')?.addEventListener('click',()=>openDraw({codigo:s.codigo,ventaId:null,count:s.freePending,anonymous:false}));
      document.getElementById('hwCatrinaMark')?.addEventListener('click',async()=>{
        if(!confirm(`Confirmar que entregaste la Catrina al Jack ${s.codigo}?`))return;
        await Core.markCatrina(s.codigo,true);emitHalloweenEvent('catrina_cambio',{codigo:s.codigo,entregada:true});await lookupJack();
      });
      bindHoldButton(document.getElementById('hwCatrinaUndo'),900,async()=>{
        if(!confirm(`CORRECCIÓN: ¿revertir la entrega de Catrina de ${s.codigo}?`))return;
        await Core.markCatrina(s.codigo,false);emitHalloweenEvent('catrina_cambio',{codigo:s.codigo,entregada:false});await lookupJack();
      });
      document.getElementById('hwRedeem')?.addEventListener('click',async()=>{
        try{
          const physical=document.getElementById('hwPhysical')?.checked===true;
          if(!physical){alert('Marca primero que el Jack físico fue presentado.');return;}
          if(!confirm(`CANJE FINAL\n\nJack: ${s.codigo}\nAcumulado: ${money(s.acumulado)}\nNivel: ${s.nivel||'sin nivel'}\n\nEsto registra Bolo + Charro Negro y después ya no mostrará el botón de canje. ¿Confirmar?`))return;
          const out=await Core.redeem(s.codigo,true);
          if(out.yaCanjeada)alert('⚠️ Este Jack YA FUE CANJEADO.');
          else {emitHalloweenEvent('canje_31',{codigo:s.codigo,acumulado:out.result.acumulado,nivel:out.result.nivel,charro:true});alert(`CANJE REGISTRADO\n\nEntregar: Bolo ${out.result.nivel||''} + Charro Negro\nAcumulado: ${money(out.result.acumulado)}`);}
          await lookupJack();await refreshStats();
        }catch(e){alert(e.message);}
      });
      document.getElementById('hwSaveJackNote')?.addEventListener('click',async()=>{
        try{ const note=document.getElementById('hwJackNote')?.value||''; await Core.saveJackNote(s.codigo,note); showMsg('Nota del Jack guardada'); await lookupJack(); }
        catch(e){alert(e.message);}
      });
      document.getElementById('hwAlbumState').onclick=()=>openAlbumState(s);
    }catch(e){alert(e.message);}
  }

  async function openAlbumState(snapshot){
    const inv=await Core.listInventory();
    UI.albumContext={codigo:snapshot.codigo,selected:new Set(snapshot.profile.reportedOwned||[]),inventory:inv};
    const grid=document.getElementById('hwAlbumGrid'); grid.innerHTML='';
    for(const c of inv){
      const b=document.createElement('button'); b.type='button'; b.className='hw-checkpick'; b.dataset.id=c.id;
      b.innerHTML=`<span class="hw-checkmark"></span><span><b>${escapeHtml(c.nombre)}</b><small style="display:block;color:var(--text-muted);">${escapeHtml(c.numero||c.id)}</small></span>`;
      b.addEventListener('click',()=>toggleAlbumCard(c.id,b));
      updateAlbumCardVisual(c.id,b);
      grid.appendChild(b);
    }
    updateAlbumCount();
    document.getElementById('hwAlbumOverlay').style.display='flex';
  }

  function updateAlbumCardVisual(id,btn){
    const sel=!!UI.albumContext?.selected?.has(id);
    btn.classList.toggle('sel',sel);
    const mark=btn.querySelector('.hw-checkmark'); if(mark)mark.textContent=sel?'✓':'';
  }
  function updateAlbumCount(){
    const n=UI.albumContext?.selected?.size||0; const total=UI.albumContext?.inventory?.length||17;
    const el=document.getElementById('hwAlbumCount'); if(el)el.textContent=`${n}/${total}`;
  }
  function toggleAlbumCard(id,btn){
    const ctx=UI.albumContext; if(!ctx)return;
    if(ctx.selected.has(id))ctx.selected.delete(id); else ctx.selected.add(id);
    updateAlbumCardVisual(id,btn); updateAlbumCount();
  }
  async function saveAlbumState(){
    const ctx=UI.albumContext; if(!ctx)return;
    const ids=[...ctx.selected];
    try{
      await Core.saveReportedOwned(ctx.codigo,ids);
      document.getElementById('hwAlbumOverlay').style.display='none'; UI.albumContext=null;
      showMsg(`Estado declarado: ${ids.length}/17`); await lookupJack();
    }catch(e){alert(e.message);}
  }

  async function refreshOperationalMode(){
    const st=document.getElementById('hwModeStatus'), btn=document.getElementById('hwModeToggle'), reset=document.getElementById('hwResetTests');
    if(!st||!UI.initialized)return;
    const mode=await Core.getOperationalMode();
    if(mode==='produccion'){
      st.innerHTML='Modo: <b class="hw-ok">🔒 PRODUCCIÓN 2026</b> · borrar pruebas requiere desbloqueo deliberado';
      if(btn)btn.textContent='Volver a modo pruebas';
      if(reset){reset.disabled=false;reset.style.opacity='.65';reset.textContent='🔒 Borrar temporada de prueba';}
    }else{
      st.innerHTML='Modo: <b>🧪 PRUEBAS</b> · puedes limpiar y volver a empezar';
      if(btn)btn.textContent='🔒 Activar PRODUCCIÓN 2026';
      if(reset){reset.disabled=false;reset.style.opacity='1';reset.textContent='Borrar temporada de prueba';}
    }
  }
  async function toggleOperationalMode(){
    try{
      const mode=await Core.getOperationalMode();
      if(mode==='produccion'){
        const typed=prompt('Esto sólo desbloquea las herramientas de prueba; no borra nada.\\n\\nEscribe VOLVER A PRUEBAS:','');
        if(String(typed||'').trim().toUpperCase()!=='VOLVER A PRUEBAS'){showMsg('Cancelado');return;}
        await Core.setOperationalMode('pruebas');
      }else{
        const typed=prompt('En PRODUCCIÓN se bloquea Borrar temporada de prueba.\\n\\nEscribe PRODUCCION 2026 para activar:','');
        if(String(typed||'').trim().toUpperCase()!=='PRODUCCION 2026'){showMsg('Cancelado');return;}
        await Core.setOperationalMode('produccion');
      }
      await refreshOperationalMode(); showMsg('Modo actualizado');
    }catch(e){alert(e.message);}
  }

  function downloadBlobFile(filename,blob){
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),2500);
  }

  function downloadJsonFile(filename,data){
    downloadBlobFile(filename,new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}));
  }

  function downloadPlainText(filename,text){
    downloadBlobFile(filename,new Blob([text],{type:'text/plain;charset=utf-8'}));
  }

  async function safeCopy(text){
    if(typeof copyText==='function') return await copyText(text);
    try{ await navigator.clipboard.writeText(text); return true; }
    catch(_){ return false; }
  }

  function qrSvgForCode(code){
    if(typeof root.HWQRCode!=='function'||!root.HWQRErrorCorrectLevel) throw new Error('El generador QR local no cargó. Recarga la página antes de crear un lote.');
    const qr=new root.HWQRCode(0,root.HWQRErrorCorrectLevel.M);
    qr.addData(String(code)); qr.make();
    const n=qr.getModuleCount(), quiet=4, total=n+quiet*2;
    let d='';
    for(let r=0;r<n;r++) for(let c=0;c<n;c++) if(qr.isDark(r,c)) d+=`M${c+quiet} ${r+quiet}h1v1h-1z`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>\n`;
  }

  async function sha256Hex(text){
    try{
      if(!crypto?.subtle)return null;
      const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(text)));
      return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
    }catch(_){return null;}
  }

  let CRC_TABLE=null;
  function crc32(bytes){
    if(!CRC_TABLE){
      CRC_TABLE=new Uint32Array(256);
      for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);CRC_TABLE[n]=c>>>0;}
    }
    let c=0xFFFFFFFF; for(const b of bytes)c=CRC_TABLE[(c^b)&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0;
  }
  function put16(a,o,v){a[o]=v&255;a[o+1]=(v>>>8)&255;}
  function put32(a,o,v){a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255;}
  function concatBytes(parts){const len=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(len);let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;}
  function makeStoredZip(entries){
    const enc=new TextEncoder(), locals=[], centrals=[]; let offset=0;
    for(const ent of entries){
      const name=enc.encode(ent.name), data=ent.data instanceof Uint8Array?ent.data:enc.encode(String(ent.data)), crc=crc32(data);
      const lh=new Uint8Array(30+name.length); put32(lh,0,0x04034b50);put16(lh,4,20);put16(lh,6,0x0800);put16(lh,8,0);put16(lh,10,0);put16(lh,12,0);put32(lh,14,crc);put32(lh,18,data.length);put32(lh,22,data.length);put16(lh,26,name.length);put16(lh,28,0);lh.set(name,30);
      locals.push(lh,data);
      const ch=new Uint8Array(46+name.length); put32(ch,0,0x02014b50);put16(ch,4,20);put16(ch,6,20);put16(ch,8,0x0800);put16(ch,10,0);put16(ch,12,0);put16(ch,14,0);put32(ch,16,crc);put32(ch,20,data.length);put32(ch,24,data.length);put16(ch,28,name.length);put16(ch,30,0);put16(ch,32,0);put16(ch,34,0);put16(ch,36,0);put32(ch,38,0);put32(ch,42,offset);ch.set(name,46);centrals.push(ch);
      offset+=lh.length+data.length;
    }
    const central=concatBytes(centrals), end=new Uint8Array(22); put32(end,0,0x06054b50);put16(end,4,0);put16(end,6,0);put16(end,8,entries.length);put16(end,10,entries.length);put32(end,12,central.length);put32(end,16,offset);put16(end,20,0);
    return new Blob([...locals,central,end],{type:'application/zip'});
  }

  function csvCell(v){const s=String(v??'');return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}

  async function generateBatch(){
    const n=Math.floor(Number(document.getElementById('hwBatchCount').value)||0); if(n<1)return;
    if(typeof root.HWQRCode!=='function'||!root.HWQRErrorCorrectLevel){alert('El generador QR local no cargó. Recarga la página. No se creó ningún Jack.');return;}
    const mode=await Core.getOperationalMode();
    const isProd=mode==='produccion';
    const label=isProd?'PRODUCCIÓN':'PRUEBAS';
    const warning=isProd?'Estos códigos serán candidatos a impresión real. Guarda el paquete antes de imprimir.':'Este lote es de PRUEBA. Se borrará al limpiar la temporada y NO debe imprimirse como producción.';
    if(!confirm(`Generar ${n} Jacks en modo ${label}?\n\n${warning}\n\nCada Jack nacerá en la base y el paquete incluirá su QR SVG, CSV y MAESTRO.json.`))return;

    let out;
    try{ out=await Folios.generarLote(n,config.prefijo); }
    catch(e){ alert('No se pudieron crear los Jacks: '+e.message); return; }

    let master=null,zipName=null;
    try{
      const exp=await Folios.exportar(), wanted=new Set(out.codigos), created=new Date().toISOString();
      const fullBackup=await Core.exportAll();
      const fingerprint=await sha256Hex(out.codigos.slice().sort().join('\n'));
      master={...exp,kind:'HW2026_JACK_BATCH_MASTER',batch:{lote:out.lote,prefijo:out.prefijo,cantidad:out.cantidad,creadoEn:created,modo:mode,fingerprintSha256:fingerprint,qr:{contenido:'codigo',formato:'SVG',correccion:'M',margenModulos:4}},folios:(exp.folios||[]).filter(f=>wanted.has(f.codigo))};
      const rows=[['codigo','lote','estado','qr_archivo','qr_contenido','modo']];
      const entries=[];
      for(const code of out.codigos){
        const svg=qrSvgForCode(code); entries.push({name:`QR/${code}.svg`,data:svg});
        rows.push([code,out.lote,'impresa',`QR/${code}.svg`,code,mode]);
      }
      const csv=rows.map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
      const prefix=isProd?'PRODUCCION':'PRUEBA';
      const base=`${prefix}_Jacks_${out.lote}`;
      const readme=[
        'JUGAAD HALLOWEEN 2026 — PAQUETE JACK',
        `Modo: ${label}`,
        `Lote: ${out.lote}`,
        `Cantidad: ${out.codigos.length}`,
        `Creado: ${created}`,
        fingerprint?`Huella SHA-256 de la lista de códigos: ${fingerprint}`:'Huella SHA-256: no disponible en este navegador',
        '',
        'ARCHIVOS:',
        '- MAESTRO.json = identidad exacta de los Jacks físicos de este lote. CONSERVAR.',
        '- Jacks.csv = relación código/lote/archivo QR para maquetación.',
        '- RESPALDO_INICIAL.json = foto completa del sistema justo después de crear el lote.',
        '- QR/*.svg = QR estándar, negro sobre blanco, contenido = código Jack.',
        '',
        isProd?'PRODUCCIÓN: guarda este ZIP en al menos dos lugares antes de imprimir.':'PRUEBAS: no imprimir como lote real; puede borrarse del sistema con Borrar temporada de prueba.',
        'El QR es regenerable desde el código; el código Jack es el dato maestro.'
      ].join('\n');
      entries.unshift(
        {name:'MAESTRO.json',data:JSON.stringify(master,null,2)+'\n'},
        {name:'RESPALDO_INICIAL.json',data:JSON.stringify(fullBackup,null,2)+'\n'},
        {name:'Jacks.csv',data:csv},
        {name:'LEEME.txt',data:readme+'\n'}
      );
      const zip=makeStoredZip(entries); zipName=`${base}_IMPRESION.zip`; downloadBlobFile(zipName,zip);
      await Core.markBackupNow(); await refreshBackupStatus();
      UI.lastBatchMaster=master; UI.lastBatchZipName=zipName;
    }catch(e){
      console.error('batch package',e);
      if(master){ try{downloadJsonFile(`Jacks_${out.lote}_MAESTRO_RECUPERACION.json`,master);}catch(_){} }
      alert(`Los ${out.codigos.length} Jacks SÍ quedaron creados en la base, pero falló la creación/descarga del paquete de QR.\n\nNO IMPRIMAS todavía. Descarga un respaldo JSON completo y usa Recuperar Jacks antes de continuar.\n\n${e.message}`);
      await refreshStats(); return;
    }

    const text=['codigo\tlote\tqr',...out.codigos.map(c=>`${c}\t${out.lote}\t${c}`)].join('\n');
    const copied=await safeCopy(text);
    alert(`${out.codigos.length} Jacks CREADOS en modo ${label}.\nLote: ${out.lote}\n\nPaquete: ${zipName}\nIncluye MAESTRO.json + RESPALDO_INICIAL.json + Jacks.csv + ${out.codigos.length} QR SVG.\n\n${isProd?'GUÁRDALO EN DOS LUGARES ANTES DE IMPRIMIR.':'Es un paquete de PRUEBA; no lo mezcles con producción.'}${copied?'\n\nLa lista también quedó copiada al portapapeles.':''}`);
    await refreshStats();
  }

  async function copyJackRegistry(){
    try{
      const data=await Folios.exportar();
      const rows=(data.folios||[]).slice().sort((a,b)=>String(a.creadoEn||'').localeCompare(String(b.creadoEn||'')));
      if(!rows.length){showMsg('No hay Jacks para copiar');return;}
      const out=[];
      for(const f of rows){
        const p=await Core.getProfile(f.codigo,false);
        out.push([f.codigo||'',f.lote||'',f.estado||'',Number(f.acumulado||0),f.nivel||'',f.creadoEn||'',f.entregadoEn||'',f.canjeadoEn||'',p?.nota||'']);
      }
      const text=['codigo\tlote\testado\tacumulado\tnivel\tcreadoEn\tentregadoEn\tcanjeadoEn\tnota',...out.map(r=>r.join('\t'))].join('\n');
      const ok=await safeCopy(text);
      if(ok) alert(`${rows.length} Jacks copiados.\n\nPégalos en la pestaña Halloween_Jacks. Incluye la nota/nombre/recordatorio.`);
      else downloadPlainText(`Halloween_Jacks_${new Date().toISOString().slice(0,10)}.tsv`,text);
    }catch(e){alert('No se pudo copiar el padrón de Jacks: '+e.message);}
  }

  async function restoreBatchMasterFile(ev){
    const input=ev.target, file=input.files?.[0]; if(!file)return;
    try{
      const data=JSON.parse(await file.text());
      if(data.kind!=='HW2026_JACK_BATCH_MASTER' || !Array.isArray(data.folios)) throw new Error('Ese archivo no parece ser un maestro de lote Jack.');
      const expectedHash=data.batch?.fingerprintSha256||null;
      if(expectedHash){
        const actualHash=await sha256Hex(data.folios.map(f=>normalizeCode(f.codigo)).sort().join('\n'));
        if(actualHash && actualHash!==expectedHash) throw new Error('La huella del MAESTRO.json no coincide. El archivo pudo alterarse o dañarse. No se importó nada.');
      }
      const a=await Folios.analizarImportacion(data);
      const lote=data.batch?.lote||data.folios?.[0]?.lote||'sin lote';
      if(!confirm(`Restaurar lote ${lote}\n\nCódigos del archivo: ${data.folios.length}\nNuevos en este dispositivo: ${a.nuevos}\nYa iguales: ${a.iguales}\nLocal con más historia: ${a.localMasNuevo}\nConflictos: ${a.conflictos}\n\nLa restauración fusiona: no hace retroceder Jacks locales con más historia.`)){return;}
      const out=await Folios.aplicarImportacion(data,{confirmado:true,resolverConflictos:'mantener_local'});
      alert(`Lote restaurado/fusionado.\nCódigos aplicados: ${out.aplicados}\nLos Jacks locales con más historia se conservaron.`);
      await refreshStats();
    }catch(e){alert('No se pudo restaurar el lote: '+e.message);}
    finally{input.value='';}
  }

  async function recoverExistingJacks(){
    try{
      const data=await Folios.exportar();
      const rows=(data.folios||[]).slice().sort((a,b)=>String(a.creadoEn||'').localeCompare(String(b.creadoEn||'')));
      if(!rows.length){ showMsg('Todavía no hay Jacks creados en este dispositivo'); return; }
      const text=['codigo\tlote\testado\tcreado',...rows.map(f=>`${f.codigo||''}\t${f.lote||''}\t${f.estado||''}\t${f.creadoEn||''}`)].join('\n');
      const copied=await safeCopy(text);
      if(copied){
        alert(`${rows.length} Jacks existentes copiados al portapapeles.\n\nEsto también recupera lotes que pudieron haberse creado aunque hubiera fallado la copia.`);
      }else{
        downloadPlainText(`Jacks_existentes_${new Date().toISOString().slice(0,10)}.txt`,text);
        alert(`${rows.length} Jacks encontrados. El navegador no permitió copiar, así que descargué un TXT con todos.`);
      }
    }catch(e){ alert('No se pudieron recuperar los Jacks: '+e.message); }
  }

  async function resetTestsUI(){
    try{
      const mode=await Core.getOperationalMode();
      if(mode==='produccion'){
        const unlock=prompt('Estás en PRODUCCIÓN 2026. No voy a ignorar el toque, pero para permitir un borrado debes desbloquear primero.\n\nEscribe VOLVER A PRUEBAS:','');
        if(String(unlock||'').trim().toUpperCase()!=='VOLVER A PRUEBAS'){ showMsg('Borrado cancelado · sigues en PRODUCCIÓN'); return; }
        await Core.setOperationalMode('pruebas');
        await refreshOperationalMode();
      }

      let jacks=0;
      try{ jacks=(await Folios.exportar()).folios?.length||0; }catch(_){}
      const first=confirm(`Esto borrará la temporada de PRUEBA de este dispositivo.\n\nJacks actuales: ${jacks}\nTambién se borrarán acumulados, cartas, inventario y movimientos Halloween.\nNO toca las ventas normales del ERP.\nLos ZIP/JSON de prueba que ya descargaste NO se borran del teléfono/PC.\n\n¿Continuar?`);
      if(!first)return;
      const typed=prompt('Última protección. Escribe exactamente BORRAR PRUEBAS:','');
      if(String(typed||'').trim().toUpperCase()!=='BORRAR PRUEBAS'){ showMsg('Cancelado'); return; }

      // No intentamos vaciar bases que están abiertas en esta misma página.
      // Marcamos el borrado y recargamos; al arrancar, antes de Folios.init/Core.init,
      // se eliminan ambas bases completas. Es más fiable en Chrome/Android.
      localStorage.setItem('hw2026_pending_hard_reset',JSON.stringify({jacks,requestedAt:new Date().toISOString(),version:APP_VERSION}));
      try{ localStorage.removeItem('hw2026_writer_lock'); }catch(_){}
      location.reload();
    }catch(e){ alert('No se pudo preparar el borrado: '+e.message); }
  }

  function niceDate(v){ if(!v)return 'nunca'; try{return new Date(v).toLocaleString();}catch(_){return String(v);} }
  async function refreshBackupStatus(){
    const el=document.getElementById('hwBackupStatus'); if(!el||!UI.initialized)return;
    try{ const s=await Core.backupStatus(); el.innerHTML=`Pendientes para hoja: <b>${s.pending}</b> · último pase: ${escapeHtml(niceDate(s.lastAuditAt))}<br>Último JSON: ${escapeHtml(niceDate(s.lastBackupAt))}`;
      const mark=document.getElementById('hwAuditMarkBtn'); if(mark){mark.style.display=s.pendingConfirmIds?.length?'block':'none';mark.textContent=s.pendingConfirmIds?.length?`✓ Ya pegué ${s.pendingConfirmIds.length} · marcar respaldados`:'✓ Ya los pegué · marcar respaldados';}
    }catch(e){ el.textContent='No se pudo leer el estado de respaldo'; }
  }

  async function downloadBackup(){
    try{ const data=await Core.exportAll(); const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`HW2026_${new Date().toISOString().slice(0,10)}_principal.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);await Core.markBackupNow();await refreshBackupStatus();showMsg('Respaldo JSON descargado'); }
    catch(e){alert(e.message);}
  }

  async function importBackupFile(ev){
    const input=ev.target, file=input.files?.[0]; if(!file)return;
    try{
      const text=await file.text(); const a=await Core.analyzeImportAll(text); const f=a.folios;
      const msg=`Importación SEGURA por fusión. No borra datos locales.\n\nJacks nuevos: ${f.nuevos}\nRespaldo con más historia: ${f.cambios}\nLocal con más historia (se conserva): ${f.localMasNuevo}\nConflictos (se conserva local): ${f.conflictos}\nEventos contenidos en JSON: ${a.counts.events}\nVentas Halloween contenidas: ${a.counts.sales}\n\n¿Aplicar?`;
      if(!confirm(msg)){input.value='';return;}
      const out=await Core.importAllMerge(text);
      alert(`Importación terminada sin borrar lo que ya tenías.\nJacks aplicados: ${out.folios.aplicados}\nEventos añadidos: ${out.stats.eventsAdded}\nVentas añadidas: ${out.stats.salesAdded}\nConflictos conservando local: ${out.keptLocalConflicts+out.stats.conflicts}`);
      await refreshBackupStatus(); await refreshStats();
    }catch(e){ alert('No se pudo importar: '+e.message); }
    finally{ input.value=''; }
  }

  async function copyAudit(){
    try{
      const pack=await Core.auditPendingTSV(); if(!pack.count){showMsg('No hay movimientos nuevos para pasar a la hoja');return;}
      const ok=typeof copyText==='function'?await copyText(pack.text):(await navigator.clipboard.writeText(pack.text),true);
      if(!ok)throw new Error('No se pudo copiar al portapapeles');
      await Core.setAuditPendingConfirm(pack.ids); await refreshBackupStatus(); showMsg(`${pack.count} movimientos copiados · pégalos en la hoja`);
    }catch(e){alert(e.message);}
  }
  async function markAuditCopied(){
    try{ const s=await Core.backupStatus(), ids=s.pendingConfirmIds||[]; if(!ids.length){showMsg('No hay un lote copiado pendiente de confirmar');return;} await Core.markAuditExported(ids); await refreshBackupStatus(); showMsg(`${ids.length} movimientos marcados como respaldados`); }
    catch(e){alert(e.message);}
  }

  root.HalloweenUI=Object.freeze({openDashboard,openSale,version:APP_VERSION});
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',initUI); else setTimeout(initUI,0);
})(typeof globalThis!=='undefined'?globalThis:window);
