/*
 * halloween.js — Halloween 2026
 * Capa de temporada para el ERP de ventas.
 * - Folios (folios_v2.js) sigue siendo la autoridad para Jack: estado, acumulado, nivel y canje.
 * - Esta base separada guarda cartas, inventario, repartos, eventos y estadísticas.
 * - No guarda nombres, teléfonos ni datos personales.
 */
(function(root){
  'use strict';

  const APP_VERSION = '0.3.0';
  const DB_NAME = 'halloween_2026';
  const DB_VERSION = 1;
  const STORES = Object.freeze({
    META:'meta', PROFILES:'profiles', SALES:'sales', EVENTS:'events', INVENTORY:'inventory', OPS:'ops'
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

  async function acquireWriterLock(){
    // Un bloqueo sencillo entre pestañas del mismo navegador. No sustituye el respaldo.
    const key='hw2026_writer_lock';
    const id=uuid();
    const ttl=12000;
    const now=Date.now();
    let cur=null;
    try{ cur=JSON.parse(localStorage.getItem(key)||'null'); }catch(_){ }
    if(cur && cur.expires>now && cur.id!==id) return {ok:false,holder:cur.id};
    const write=()=>localStorage.setItem(key,JSON.stringify({id,expires:Date.now()+ttl}));
    write();
    writerLock={owned:true,id,timer:setInterval(write,5000)};
    root.addEventListener('beforeunload',()=>{ try{ const c=JSON.parse(localStorage.getItem(key)||'null'); if(c&&c.id===id)localStorage.removeItem(key); }catch(_){} });
    return {ok:true,id};
  }

  async function getProfile(codigo, create=true){
    const code=normalizeCode(codigo); if(!code) return null;
    const tx=db.transaction([STORES.PROFILES],'readwrite'); const st=tx.objectStore(STORES.PROFILES);
    let p=await reqPromise(st.get(code));
    if(!p && create){
      p={ codigo:code, creadoEn:nowIso(), actualizadoEn:nowIso(), freeDelivered:0, cardHistory:[], rescates:0, catrina:false, charro:false, albumComplete:false, reportedOwned:[], reportedAt:null };
      st.add(p);
    }
    await txPromise(tx); return p?clone(p):null;
  }

  async function saveProfile(p){
    p.actualizadoEn=nowIso();
    const tx=db.transaction([STORES.PROFILES],'readwrite'); tx.objectStore(STORES.PROFILES).put(clone(p)); await txPromise(tx); return clone(p);
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
    if(!writerLock.owned) throw new Error('Esta pestaña no tiene permiso de escritura Halloween.');
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
      if(!p) p={ codigo:code, creadoEn:fecha, actualizadoEn:fecha, freeDelivered:0, cardHistory:[], rescates:0, catrina:false, charro:false, albumComplete:false, reportedOwned:[], reportedAt:null };
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
      if(!p)p={codigo:code,creadoEn:fecha,actualizadoEn:fecha,freeDelivered:0,cardHistory:[],rescates:0,catrina:false,charro:false,albumComplete:false,reportedOwned:[],reportedAt:null};
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
    return {
      jacksActivos:active.length, acumuladoTotal:vals.reduce((a,b)=>a+b,0), acumuladoPromedio:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0,
      niveles:levels, perfiles:profiles.length, ventasHalloween:sales.length, pendientesOps:ops.filter(x=>x.estado!=='completada').length,
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
    const counts={}; for(const k of ['profiles','sales','events','inventory','ops']) counts[k]=Array.isArray(incoming[k])?incoming[k].length:0;
    return {folios:foliosAnalysis,counts,exportedAt:data.exportedAt||null,version:data.version||null};
  }

  async function importAllMerge(input){
    if(!writerLock.owned) throw new Error('Esta pestaña no tiene permiso de escritura Halloween.');
    const data=parseFullBackup(input);
    const incoming=data.halloween||{};
    const current={};
    for(const [k,name] of Object.entries(STORES)) current[k.toLowerCase()]=await getStoreRows(name);
    const foliosBefore=await Folios.exportar();
    const substantiveLocal=((current.profiles?.length||0)+(current.sales?.length||0)+(current.events?.length||0)+(current.ops?.length||0)>0) || ((foliosBefore.folios||[]).length>0);
    const folioAnalysis=await Folios.analizarImportacion(data.folios);
    const folioResult=await Folios.aplicarImportacion(data.folios,{confirmado:true,resolverConflictos:'mantener_local'});
    const stats={profilesAdded:0,profilesMerged:0,salesAdded:0,salesMerged:0,eventsAdded:0,opsAdded:0,inventoryRestored:0,conflicts:0};

    const tx=db.transaction([STORES.PROFILES,STORES.SALES,STORES.EVENTS,STORES.INVENTORY,STORES.OPS],'readwrite');
    const pSt=tx.objectStore(STORES.PROFILES), sSt=tx.objectStore(STORES.SALES), eSt=tx.objectStore(STORES.EVENTS), iSt=tx.objectStore(STORES.INVENTORY), oSt=tx.objectStore(STORES.OPS);
    try{
      const pMap=new Map((current.profiles||[]).map(x=>[normalizeCode(x.codigo),x]));
      for(const raw of incoming.profiles||[]){ const inc=clone(raw); inc.codigo=normalizeCode(inc.codigo); const cur=pMap.get(inc.codigo); if(!cur){pSt.put(inc);stats.profilesAdded++;}else{pSt.put(mergeProfile(cur,inc));stats.profilesMerged++;} }

      const sMap=new Map((current.sales||[]).map(x=>[String(x.ventaId),x]));
      for(const raw of incoming.sales||[]){ const inc=clone(raw); const key=String(inc.ventaId); const cur=sMap.get(key); if(!cur){sSt.put(inc);stats.salesAdded++;}else{const m=mergeSale(cur,inc);sSt.put(m.record);stats.salesMerged++;stats.conflicts+=m.conflicts;} }

      const eIds=new Set((current.events||[]).map(x=>String(x.id)));
      for(const inc of incoming.events||[]){ if(!eIds.has(String(inc.id))){eSt.put(clone(inc));eIds.add(String(inc.id));stats.eventsAdded++;} }

      const oMap=new Map((current.ops||[]).map(x=>[String(x.id),x]));
      for(const inc0 of incoming.ops||[]){ const inc=clone(inc0), key=String(inc.id), cur=oMap.get(key); if(!cur){oSt.put(inc);stats.opsAdded++;}else if(cur.estado==='pendiente'&&inc.estado!=='pendiente'){oSt.put(inc);} }

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
    const head=['MovimientoID','Fecha','Evento','VentaID','ParteID','Jack','Monto','Acumulado','Nivel','Cartas','Productos'];
    const rows=events.map(e=>{
      const sale=saleMap.get(String(e.ventaId||''));
      const productos=(sale?.items||[]).map(i=>`${i.nombre} x${i.cantidad} @${Number(i.precio||0).toFixed(2)}`).join(' | ');
      return [e.id||'',e.fecha||'',e.tipo||'',e.ventaId||'',e.partId||'',e.codigo||'',e.monto??'',e.acumulado??'',e.nivel||'',(e.cardIds||[]).join(','),productos];
    });
    return {text:[head,...rows].map(r=>r.join('\t')).join('\n'),ids:events.map(e=>String(e.id)),count:events.length};
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
    const d=await new Promise((resolve,reject)=>{ const r=indexedDB.open('folios_HW2026'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error||new Error('No se pudo abrir Folios')); });
    const stores=['folios','meta','ventas'].filter(x=>d.objectStoreNames.contains(x));
    if(stores.length){ const tx=d.transaction(stores,'readwrite'); for(const name of stores)tx.objectStore(name).clear(); await txPromise(tx); }
    d.close();
  }

  async function resetSeasonForTests(){
    if(!writerLock.owned) throw new Error('Esta pestaña no tiene permiso de escritura Halloween.');
    const names=Object.values(STORES); const tx=db.transaction(names,'readwrite'); for(const name of names)tx.objectStore(name).clear(); await txPromise(tx);
    config={...DEFAULT_CONFIG}; await metaSet('config',config); await ensureInventory(); await clearFoliosForTests();
    return {ok:true};
  }

  async function configure(patch){ config={...config,...patch}; await metaSet('config',config); return clone(config); }

  const Core=Object.freeze({
    init:initCore,configure,get config(){return clone(config);},levels:LEVELS,cards:DEFAULT_CARDS,
    captureSale,getSale,getJackSales,applyAllocation,closeSaleWithoutJack,getProfile,jackSnapshot,listInventory,setInventory,registerDraw,registerQuickCards,
    markCatrina,saveReportedOwned,redeem,summary,exportAll,auditTSV,auditPendingTSV,setAuditPendingConfirm,markAuditExported,backupStatus,markBackupNow,
    analyzeImportAll,importAllMerge,reconcileOps,acquireWriterLock,folioHasSale,resetSeasonForTests
  });
  root.Halloween2026=Core;

  /* =========================== UI =========================== */
  const UI={ currentSale:null, currentJack:null, selectedCards:[], drawContext:null, initialized:false, noJackConfirmUntil:0, noJackTimer:null };

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
      .hw-overlay{z-index:220}.hw-wide{max-width:440px}.hw-line{display:flex;gap:8px;align-items:center}.hw-line>*{flex:1}
      .hw-danger{color:var(--danger)}.hw-ok{color:var(--ok)}.hw-section{margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}
      .hw-pill{display:inline-block;padding:3px 8px;border-radius:20px;background:var(--surface-2);font-size:11px;margin:2px}
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
    document.getElementById('hwSaleClose').onclick=()=>{ saleOverlay.style.display='none'; };

    const draw=document.createElement('div'); draw.id='hwDrawOverlay'; draw.className='overlay hw-overlay'; draw.style.display='none'; draw.innerHTML=`
      <div class="overlay-card hw-wide"><div class="overlay-header"><strong>🃏 Registrar cartas de la urna</strong><button class="close-x" id="hwDrawClose">✕</button></div>
      <div id="hwDrawIntro" class="hw-muted"></div><div id="hwCardGrid" class="hw-cardgrid"></div>
      <div class="total-line"><span>Seleccionadas</span><strong id="hwDrawCount">0/0</strong></div>
      <button class="btn-primary" id="hwDrawConfirm">Confirmar cartas</button>
      <button class="btn-secondary btn-block" id="hwDrawQuick" style="margin-top:8px;">⚡ Entrega rápida sin registrar cuáles</button>
      </div>`; document.body.appendChild(draw);
    document.getElementById('hwDrawClose').onclick=()=>{ draw.style.display='none'; };
    document.getElementById('hwDrawConfirm').onclick=confirmDraw;
    document.getElementById('hwDrawQuick').onclick=confirmQuickDraw;

    const dash=document.createElement('div'); dash.id='hwDashboardOverlay'; dash.className='overlay hw-overlay'; dash.style.display='none'; dash.innerHTML=`
      <div class="overlay-card hw-wide" style="max-height:90vh;overflow:auto;"><div class="overlay-header"><strong>🎃 Halloween 2026</strong><button class="close-x" id="hwDashClose">✕</button></div>
      <div id="hwSystemStatus" class="hw-muted"></div>
      <div class="hw-grid" id="hwStats"></div>
      <div class="hw-section"><strong>Buscar Jack</strong><div class="hw-line" style="margin-top:8px;"><input id="hwLookupCode" type="text" placeholder="H26-XXXXXX"><button class="btn-secondary" id="hwLookupBtn">Buscar</button></div><div id="hwJackPanel"></div></div>
      <div class="hw-muted" style="margin-top:14px;">Configuración, inventario, lotes y respaldos están en ⚙️ Opciones.</div>
      </div>`; document.body.appendChild(dash);
    document.getElementById('hwDashClose').onclick=()=>{dash.style.display='none'; document.getElementById('btnHalloweenMode')?.classList.remove('active');};
    document.getElementById('hwLookupBtn').onclick=lookupJack;

    const mount=document.getElementById('hwOptionsMount');
    if(mount){
      mount.innerHTML=`<div id="hwOptionsSection" style="display:none;">
        <div class="section-title">🎃 Halloween 2026</div>
        <details id="hwInvDetails" class="card" style="padding:12px;margin-bottom:8px;">
          <summary style="cursor:pointer;font-weight:700;">Cartas e inventario</summary>
          <div class="hw-muted" style="margin-top:6px;">Configuración interna de las 17 cartas normales. No aparece durante una venta.</div>
          <div id="hwInventoryPanel" style="margin-top:8px;"></div>
        </details>
        <details class="card" style="padding:12px;margin-bottom:8px;">
          <summary style="cursor:pointer;font-weight:700;">Jacks, respaldo y auditoría</summary>
          <div class="hw-line" style="margin-top:10px;"><input id="hwBatchCount" type="number" min="1" value="50"><button class="btn-secondary" id="hwGenerateBatch">Generar lote Jack</button></div>
          <div id="hwBackupStatus" class="hw-muted" style="margin-top:8px;">Calculando respaldos…</div>
          <button class="btn-secondary btn-block" id="hwBackupBtn" style="margin-top:8px;">💾 Descargar respaldo JSON completo</button>
          <button class="btn-secondary btn-block" id="hwImportBtn" style="margin-top:8px;">↩️ Importar JSON · fusionar sin borrar</button>
          <input id="hwImportFile" type="file" accept="application/json,.json" style="display:none;">
          <button class="btn-secondary btn-block" id="hwAuditBtn" style="margin-top:8px;">📋 Copiar movimientos nuevos para hoja</button>
          <button class="btn-secondary btn-block" id="hwAuditMarkBtn" style="margin-top:8px;display:none;">✓ Ya los pegué · marcar respaldados</button>
        </details>
        <details class="card" style="padding:12px;margin-bottom:8px;">
          <summary style="cursor:pointer;font-weight:700;">🧪 Pruebas</summary>
          <div class="hw-muted" style="margin:8px 0;">Borra únicamente Halloween 2026 y los Jacks de prueba. No borra las ventas normales del ERP.</div>
          <button class="btn-secondary btn-block" id="hwResetTests" style="border-color:var(--danger);color:var(--danger);">Borrar temporada de prueba</button>
        </details>
      </div>`;
      document.getElementById('hwGenerateBatch').onclick=generateBatch;
      document.getElementById('hwBackupBtn').onclick=downloadBackup;
      document.getElementById('hwImportBtn').onclick=()=>document.getElementById('hwImportFile').click();
      document.getElementById('hwImportFile').onchange=importBackupFile;
      document.getElementById('hwAuditBtn').onclick=copyAudit;
      document.getElementById('hwAuditMarkBtn').onclick=markAuditCopied;
      document.getElementById('hwInvDetails').addEventListener('toggle',e=>{ if(e.target.open)renderInventory(); });
      document.getElementById('hwResetTests').onclick=resetTestsUI;
    }
  }

  function isHalloweenChannel(){
    const v=document.getElementById('canalSelect')?.value||'';
    return String(v).trim().toLowerCase()==='halloween';
  }

  function updateHalloweenVisibility(){
    const on=isHalloweenChannel();
    const b=document.getElementById('btnHalloweenMode'); if(b){ b.style.display=on?'flex':'none'; if(!on)b.classList.remove('active'); }
    const opt=document.getElementById('hwOptionsSection'); if(opt)opt.style.display=on?'block':'none';
    if(on) refreshBackupStatus();
    if(!on){
      const d=document.getElementById('hwDashboardOverlay'); if(d)d.style.display='none';
      const s=document.getElementById('hwSaleOverlay'); if(s)s.style.display='none';
      const dr=document.getElementById('hwDrawOverlay'); if(dr)dr.style.display='none';
    }
  }

  async function initUI(){
    try{
      injectStyles(); injectUI();
      await Core.init();
      await Folios.init({prefijo:config.prefijo,niveles:LEVELS});
      const lock=await Core.acquireWriterLock();
      const rec=await Core.reconcileOps();
      UI.initialized=true;
      const st=document.getElementById('hwSystemStatus');
      if(st) st.innerHTML=(lock.ok?'✅ Escritor principal':'⚠️ Solo consulta: otra pestaña escribe')+(rec.length?` · <span class="hw-danger">${rec.length} operación(es) a revisar</span>`:'');
      updateHalloweenVisibility();
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
        <div class="field"><label>Código Jack</label><input id="hwSaleCode" type="text" placeholder="H26-XXXXXX" autocomplete="off"><div id="hwSaleCodeStatus" class="hw-muted" style="min-height:18px;margin-top:4px;">Escribe el código; el sistema detecta si es nuevo o activo.</div></div>
        <div class="field" style="margin-top:8px;"><label>Monto para este Jack</label><input id="hwSaleAmount" type="number" min="0.01" step="0.01" value="${Number(s.unallocated).toFixed(2)}"></div>
        <button class="btn-primary" id="hwApplyJack">Aplicar a Jack</button>
        <button class="btn-secondary btn-block" id="hwNoJack" style="margin-top:8px;">Terminar sin aplicar a Jack</button>
        <div class="hw-muted" style="margin-top:8px;">Si una compra se reparte entre varios Jacks, aplica una parte y repite. Nunca podrá superar el total cobrado.</div>
      </div>`:`<div class="hw-ok" style="margin-top:10px;">✓ Venta completamente aplicada.</div>`}`;
    if(s.unallocated>0){
      document.getElementById('hwApplyJack').onclick=applySaleJack;
      document.getElementById('hwNoJack').onclick=noJackSale;
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
      const out=await Core.applyAllocation({ventaId:UI.currentSale.ventaId,codigo:code,monto:amount}); UI.currentSale=out.sale;
      emitHalloweenEvent(out.nuevo?'jack_nuevo':'compra_jack',{codigo:normalizeCode(code),monto:amount,acumulado:out.result.acumulado,nivel:out.result.nivel,ventaId:UI.currentSale.ventaId});
      if(out.nivelAntes!==out.nivelDespues && out.nivelDespues) emitHalloweenEvent('subio_nivel',{codigo:normalizeCode(code),antes:out.nivelAntes,despues:out.nivelDespues,acumulado:out.result.acumulado});
      if(out.cardsOwed>0) await openDraw({codigo:normalizeCode(code),ventaId:UI.currentSale.ventaId,count:out.cardsOwed,anonymous:false});
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
      document.getElementById('hwSaleOverlay').style.display='none'; showMsg('Venta normal · sin Jack');
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
      b.onclick=()=>pickCard(c.id,b); grid.appendChild(b);
    }
    document.getElementById('hwDrawOverlay').style.display='flex';
  }

  function pickCard(id,btn){
    const need=UI.drawContext.count; if(UI.selectedCards.length>=need){ showMsg('Ya seleccionaste todas'); return; }
    UI.selectedCards.push(id); const n=UI.selectedCards.filter(x=>x===id).length; btn.classList.add('sel'); const badge=btn.querySelector('.hw-count'); badge.style.display='block';badge.textContent=n;
    document.getElementById('hwDrawCount').textContent=`${UI.selectedCards.length}/${need}`;
  }

  async function confirmDraw(){
    const ctx=UI.drawContext; if(!ctx)return; if(UI.selectedCards.length!==ctx.count){showMsg(`Faltan ${ctx.count-UI.selectedCards.length} por registrar`);return;}
    try{ await Core.registerDraw({...ctx,cardIds:UI.selectedCards,source:'gratis'}); emitHalloweenEvent('cartas_entregadas',{codigo:ctx.codigo||null,ventaId:ctx.ventaId||null,cantidad:UI.selectedCards.length,cardIds:[...UI.selectedCards]}); document.getElementById('hwDrawOverlay').style.display='none'; UI.drawContext=null; UI.selectedCards=[]; showMsg('Cartas registradas'); }
    catch(e){alert(e.message);}
  }

  async function confirmQuickDraw(){
    const ctx=UI.drawContext; if(!ctx)return;
    if(!confirm(`¿Confirmar que entregaste ${ctx.count} carta(s) sin registrar cuáles? Se contará la entrega, pero no actualizará inventario por diseño.`))return;
    try{ await Core.registerQuickCards({...ctx,count:ctx.count,source:'gratis'}); emitHalloweenEvent('cartas_entregadas_rapido',{codigo:ctx.codigo||null,ventaId:ctx.ventaId||null,cantidad:ctx.count}); document.getElementById('hwDrawOverlay').style.display='none'; UI.drawContext=null; UI.selectedCards=[]; showMsg('Entrega rápida registrada'); }
    catch(e){alert(e.message);}
  }

  async function openDashboard(){
    if(!isHalloweenChannel())return; document.getElementById('btnHalloweenMode')?.classList.add('active'); document.getElementById('hwDashboardOverlay').style.display='flex'; await refreshStats();
  }

  async function refreshStats(){
    try{ const s=await Core.summary(); document.getElementById('hwStats').innerHTML=`
      <div class="hw-stat"><b>${s.jacksActivos}</b><span>Jacks</span></div><div class="hw-stat"><b>${money(s.acumuladoTotal)}</b><span>acumulado</span></div><div class="hw-stat"><b>${s.eventos}</b><span>eventos</span></div>`; }
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

  async function lookupJack(){
    const code=document.getElementById('hwLookupCode').value;
    try{
      const s=await Core.jackSnapshot(code); const p=document.getElementById('hwJackPanel');
      if(!s.existe){p.innerHTML='<div class="hw-danger" style="margin-top:8px;">Jack no encontrado.</div>';return;}
      UI.currentJack=s.codigo;
      const unique=[...new Set((s.profile.cardHistory||[]).map(x=>x.id).filter(Boolean))];
      const sales=await Core.getJackSales(s.codigo);
      const salesHtml=sales.length?`<details style="margin-top:10px;"><summary style="cursor:pointer;font-weight:700;">Compras registradas (${sales.length})</summary>
        <div style="margin-top:6px;">${sales.map(x=>{
          const items=(x.items||[]).map(i=>`<div class="sale-meta">${escapeHtml(i.nombre)} · ${i.cantidad} × ${money(i.precio)} = ${money(i.total)}</div>`).join('')||'<div class="sale-meta">Detalle de productos no disponible en esta venta antigua.</div>';
          return `<div style="padding:8px 0;border-bottom:1px solid var(--border);"><div style="display:flex;justify-content:space-between;gap:8px;"><b>${escapeHtml(x.fecha||x.createdAt||'')}</b><b>+${money(x.aplicado)}</b></div>${items}<div class="hw-muted">Cuenta completa: ${money(x.total)} · ${escapeHtml(x.ventaId)}</div></div>`;
        }).join('')}</div></details>`:'';
      p.innerHTML=`<div class="card hw-card" style="margin-top:10px;"><b>${escapeHtml(s.codigo)}</b> <span class="hw-pill">${escapeHtml(s.estado)}</span>
        <div class="total-line"><span>Acumulado</span><strong>${money(s.acumulado)}</strong></div>
        <div class="total-line"><span>Nivel</span><strong>${escapeHtml(s.nivel||'sin nivel')}</strong></div>
        <div class="total-line"><span>Cartas gratis</span><strong>${s.profile.freeDelivered}/${s.freeEarned}${s.freePending?` · ${s.freePending} pendientes`:''}</strong></div>
        <div class="hw-muted">Diseños registrados por el puesto: ${unique.length}/17. El álbum físico manda después de intercambios.</div>
        ${salesHtml}
        <div class="hw-line" style="margin-top:10px;"><button class="btn-secondary" id="hwDeliverPending">Entregar pendientes</button><button class="btn-secondary" id="hwToggleCatrina">${s.profile.catrina?'✓ Catrina':'Marcar Catrina'}</button></div>
        <div class="field-row"><input type="checkbox" id="hwPhysical"><label for="hwPhysical" style="font-size:13px;color:var(--text);">Jack físico presentado</label></div>
        <button class="btn-primary" id="hwRedeem">Canje final: bolo + Charro</button>
        <button class="btn-secondary btn-block" id="hwAlbumState" style="margin-top:8px;">Actualizar cartas que dice tener ahora</button>
      </div>`;
      document.getElementById('hwDeliverPending').onclick=()=>{ if(s.freePending>0)openDraw({codigo:s.codigo,ventaId:null,count:s.freePending,anonymous:false});else showMsg('No tiene cartas pendientes'); };
      document.getElementById('hwToggleCatrina').onclick=async()=>{await Core.markCatrina(s.codigo,!s.profile.catrina);emitHalloweenEvent('catrina_cambio',{codigo:s.codigo,entregada:!s.profile.catrina});await lookupJack();};
      document.getElementById('hwRedeem').onclick=async()=>{ try{const out=await Core.redeem(s.codigo,document.getElementById('hwPhysical').checked);if(out.yaCanjeada)alert('⚠️ Este Jack YA FUE CANJEADO.');else {emitHalloweenEvent('canje_31',{codigo:s.codigo,acumulado:out.result.acumulado,nivel:out.result.nivel,charro:true});alert(`ENTREGAR: Bolo ${out.result.nivel||''} + Charro Negro\nAcumulado: ${money(out.result.acumulado)}`);}await lookupJack();await refreshStats();}catch(e){alert(e.message);} };
      document.getElementById('hwAlbumState').onclick=()=>openAlbumState(s);
    }catch(e){alert(e.message);}
  }

  async function openAlbumState(snapshot){
    const inv=await Core.listInventory(); const owned=new Set(snapshot.profile.reportedOwned||[]); const labels=inv.map(c=>`${owned.has(c.id)?'[x]':'[ ]'} ${c.id} ${c.nombre}`).join('\n');
    const txt=prompt('Escribe los IDs que el cliente muestra que tiene, separados por coma.\n\n'+labels, [...owned].join(','));
    if(txt===null)return; const ids=[...new Set(txt.split(',').map(x=>x.trim().toUpperCase()).filter(Boolean))].filter(id=>inv.some(c=>c.id===id));
    await Core.saveReportedOwned(snapshot.codigo,ids); showMsg(`Estado declarado: ${ids.length}/17`); await lookupJack();
  }

  async function generateBatch(){
    const n=Math.floor(Number(document.getElementById('hwBatchCount').value)||0); if(n<1)return;
    if(!confirm(`Generar ${n} códigos Jack nuevos para impresión?`))return;
    try{ const out=await Folios.generarLote(n,config.prefijo); const text=['codigo\tlote',...out.codigos.map(c=>`${c}\t${out.lote}`)].join('\n'); await navigator.clipboard.writeText(text); alert(`${n} códigos generados y copiados al portapapeles.\nLote: ${out.lote}`);await refreshStats(); }
    catch(e){alert(e.message);}
  }

  async function resetTestsUI(){
    const first=confirm('Esto borrará TODOS los Jacks, acumulados, cartas, inventario y eventos de Halloween 2026 en este dispositivo. No toca las ventas normales del ERP. ¿Continuar?');
    if(!first)return;
    const typed=prompt('Escribe BORRAR PRUEBAS para confirmar:','');
    if(typed!=='BORRAR PRUEBAS'){ showMsg('Cancelado'); return; }
    try{ await Core.resetSeasonForTests(); alert('Datos Halloween de prueba borrados. La página se recargará para iniciar limpia.'); location.reload(); }
    catch(e){ alert('No se pudo borrar: '+e.message); }
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
