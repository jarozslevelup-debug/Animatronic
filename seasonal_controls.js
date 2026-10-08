/* seasonal_controls.js — controles compactos de temporada para Ventas.
 * v2
 * - Se muestra sólo en Halloween / Día de Muertos.
 * - Firebase/A2 es opcional: nunca bloquea ventas, Jack ni el reproductor local.
 * - Los botones de situaciones se leen de la configuración publicada por el A2.
 * - Música: lista programada con repeticiones exactas, exclusiones y modo aleatorio opcional.
 */

const FIREBASE_CONFIG={
  apiKey:"AIzaSyBkw1MxkhJYnqxfVxq77aY1_x0yIHHdOy4",
  authDomain:"halloween-2026-be987.firebaseapp.com",
  databaseURL:"https://halloween-2026-be987-default-rtdb.firebaseio.com/",
  projectId:"halloween-2026-be987",
  storageBucket:"halloween-2026-be987.firebasestorage.app",
  messagingSenderId:"286510623769",
  appId:"1:286510623769:web:5fe34a3ad2fffa8a374e88"
};
const ROOT='halloween2026/animatronic', DEVICE='A2';
const A2_CACHE_KEY='erp_hw2026_a2_config_cache';
const A2_AUTO_JACK_KEY='erp_hw2026_auto_jack_audio';
const MUSIC_PREFIX='erp_season_music_v2_';
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,Number(v)||0));
const safeJson=(s,fallback)=>{try{return JSON.parse(s)}catch(_){return fallback}};
const showMsg=msg=>{ if(typeof window.showToast==='function') window.showToast(msg); else console.log(msg); };
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

let fb=null, firebaseReady=false, firebaseConnected=false, a2State={}, a2Config=safeJson(localStorage.getItem(A2_CACHE_KEY)||'null',null);
let currentChannel='', expanded=false, moreSituations=false;
let autoJack=localStorage.getItem(A2_AUTO_JACK_KEY)==='1', lastJackLevel='';
let channelFiles={halloween:new Map(),dia_de_muertos:new Map()};
let musicCfg=null, playlist=[], currentPlaylistIndex=-1;
const saleClosingJobs=new Set(), jackSaleActivity=new Map();

function channelKey(){
  const v=String($('canalSelect')?.value||'').trim().toLowerCase();
  if(v==='halloween')return 'halloween';
  if(v==='dia de muertos')return 'dia_de_muertos';
  return '';
}
function channelLabel(k){return k==='halloween'?'🎃 Halloween':'💀 Día de Muertos'}
function musicDefaults(){return {volume:.70,crossfade:1.5,duckSpeaking:.15,duckFace:.55,playOnSituation:true,shuffle:false,repeat:true,sequence:[],excluded:[],associations:{}}}
function loadMusicCfg(k){
  const x=safeJson(localStorage.getItem(MUSIC_PREFIX+k)||'null',null)||{};
  const old=safeJson(localStorage.getItem('erp_season_music_v1_'+k)||'null',null)||{};
  const src=Object.keys(x).length?x:old;
  const seq=Array.isArray(src.sequence)?src.sequence:(Array.isArray(src.order)?src.order:[]);
  return {...musicDefaults(),...src,sequence:[...seq],excluded:Array.isArray(src.excluded)?[...src.excluded]:[],associations:{...(src.associations||{})}};
}
function saveMusicCfg(){if(!currentChannel||!musicCfg)return;localStorage.setItem(MUSIC_PREFIX+currentChannel,JSON.stringify(musicCfg))}
function trackKey(file){return file.webkitRelativePath||file.name}
function prettyTrack(key){const n=String(key||'').split('/').pop()||'';return n.replace(/\.[^.]+$/,'')}
function situationKeys(){
  const pools=a2Config?.pools||{};
  return Object.keys(pools).filter(k=>k.startsWith('situ_')&&pools[k]?.enabled!==false)
    .sort((a,b)=>(Number(pools[a]?.salesOrder)||99)-(Number(pools[b]?.salesOrder)||99)||a.localeCompare(b));
}
function situationLabel(k){const p=a2Config?.pools?.[k]||{};const base=p.label||k.replace(/^situ_/,'').replace(/_/g,' ');return `${p.icon||'🎭'} ${base}`.trim()}
function saleClosingConfig(){
  const c=a2Config?.salesClosing||{};
  return {mode:c.mode==='manual'?'manual':'auto',delaySec:clamp(c.delaySec??6,0,60),pool:String(c.pool||'situ_venta_cierre')};
}

function injectStyle(){
  if($('seasonalControlsStyle'))return;
  const st=document.createElement('style');st.id='seasonalControlsStyle';st.textContent=`
  #seasonalControlsMount{margin-bottom:10px}
  .sc-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  .sc-mini{display:flex;align-items:center;gap:7px;padding:8px 9px;min-width:0}
  .sc-season{font-size:11px;font-weight:800;white-space:nowrap}.sc-track{min-width:0;flex:1}.sc-track b{display:block;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sc-track small{display:block;color:var(--text-muted);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sc-iconbtn{border:1px solid var(--border);background:var(--surface-2);color:var(--text);border-radius:8px;min-width:38px;min-height:38px;padding:5px 8px;font-weight:800}.sc-iconbtn:disabled{opacity:.38}
  .sc-dot{width:9px;height:9px;border-radius:50%;background:var(--danger);display:inline-block}.sc-dot.on{background:var(--ok)}
  .sc-body{display:none;padding:0 9px 9px}.sc-body.open{display:block}.sc-details{border-top:1px solid var(--border);padding-top:8px;margin-top:3px}.sc-details summary{cursor:pointer;font-weight:800;font-size:12px;padding:4px 0}
  .sc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:6px;margin-top:7px}.sc-grid button{min-width:0;white-space:normal}
  .sc-sub{font-size:10px;color:var(--text-muted);line-height:1.45;margin-top:5px}.sc-status{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:10px;color:var(--text-muted);margin-top:5px}.sc-status b{color:var(--text)}
  .sc-alert{display:none;margin-top:8px;padding:8px;border:1px solid var(--accent);border-radius:8px;background:var(--surface-2);align-items:center;gap:8px}.sc-alert.show{display:flex}.sc-alert span{flex:1;font-size:11px}
  .sc-music-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.sc-music-actions button{flex:1 1 105px}
  .sc-range{display:grid;grid-template-columns:1fr 48px;gap:7px;align-items:center;margin-top:7px}.sc-range input{width:100%}.sc-range span{text-align:right;font-size:10px;color:var(--text-muted)}
  .sc-playlist{margin-top:8px}.sc-song{display:grid;grid-template-columns:26px minmax(0,1fr);gap:6px;padding:8px 0;border-top:1px solid var(--border);align-items:center}.sc-song:first-child{border-top:0}.sc-song-num{font-size:10px;color:var(--text-muted);text-align:center}.sc-song-name{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sc-song-tools{grid-column:1/-1;display:flex;gap:4px;align-items:center;flex-wrap:wrap}.sc-song-tools button{padding:4px 7px;min-width:31px}.sc-song select{grid-column:1/-1;font-size:11px;padding:7px}
  .sc-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:8px}.sc-settings .field{min-width:0}.sc-settings label{font-size:9px;color:var(--text-muted)}
  .sc-check{display:flex;align-items:center;gap:7px;margin-top:8px;font-size:11px}.sc-check input{width:auto}
  .sc-excluded-row{display:flex;align-items:center;gap:7px;padding:6px 0;border-top:1px solid var(--border);font-size:10px}.sc-excluded-row span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  @media(max-width:430px){.sc-season{display:none}.sc-settings{grid-template-columns:1fr}.sc-mini{gap:5px}.sc-iconbtn{min-width:36px;padding:5px 6px}}
  `;document.head.appendChild(st);
}

function injectUI(){
  const mount=$('seasonalControlsMount');if(!mount)return;
  mount.innerHTML=`<div class="sc-card">
    <div class="sc-mini">
      <div class="sc-season" id="scSeason">🎃</div>
      <div class="sc-track"><b id="scTrackTitle">Música sin cargar</b><small id="scMiniStatus">📱 A2 buscando…</small></div>
      <button class="sc-iconbtn" id="scPlay" type="button" title="Reproducir / pausa">▶</button>
      <button class="sc-iconbtn" id="scNext" type="button" title="Siguiente">⏭</button>
      <button class="sc-iconbtn" id="scA2Quick" type="button" title="Estado del A2"><span id="scA2Dot" class="sc-dot"></span></button>
      <button class="sc-iconbtn" id="scExpand" type="button" title="Mostrar controles">▾</button>
    </div>
    <div class="sc-body" id="scBody">
      <details class="sc-details" open><summary>🎭 Animatrónico · controles rápidos</summary>
        <div class="sc-status"><span>📱 <b id="scA2Text">A2 offline</b></span><span>👤 <b id="scFace">sin cara</b></span><span>🔊 <b id="scVoice">libre</b></span><span>👋 <b id="scSaleCloseMode">cierre —</b></span></div>
        <div id="scSituPrimary" class="sc-grid"></div>
        <button class="btn-secondary btn-block" id="scSituMore" type="button" style="display:none;margin-top:6px;">⋯ Más situaciones</button>
        <div id="scSituExtra" class="sc-grid" style="display:none;"></div>
        <div class="sc-sub">Los botones y su orden vienen de la configuración del control remoto. Ventas no mantiene una segunda lista.</div>
        <div class="sc-alert" id="scJackAlert"><span id="scJackAlertText">Jack subió de nivel</span><button class="btn-secondary" id="scJackReplay" type="button">▶</button></div>
        <div class="sc-check"><input id="scAutoJack" type="checkbox"><label for="scAutoJack">Disparar automáticamente el audio al subir de nivel Jack</label></div>
        <div class="sc-grid"><button class="btn-secondary" data-jack="N1" type="button">Jack N1</button><button class="btn-secondary" data-jack="N2" type="button">Jack N2</button><button class="btn-secondary" data-jack="N3" type="button">Jack N3</button><button class="btn-secondary" data-jack="N4" type="button">Jack N4</button></div>
      </details>
      <details class="sc-details"><summary>🎵 Música del puesto</summary>
        <div class="sc-music-actions"><button class="btn-secondary" id="scPickFolder" type="button">📂 Cargar carpeta</button><button class="btn-secondary" id="scPickFiles" type="button">🎵 Elegir archivos</button><button class="btn-secondary" id="scShuffle" type="button">☰ Programada</button></div>
        <input id="scFolderInput" type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav" multiple webkitdirectory directory style="display:none">
        <input id="scFilesInput" type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav" multiple style="display:none">
        <div class="sc-sub" id="scMusicLoadHint">Carga la carpeta. La lista programada puede repetir el mismo archivo en puntos exactos; esos ajustes se guardan aunque el navegador pueda pedir volver a autorizar los archivos.</div>
        <div class="sc-range"><input id="scMusicVolume" type="range" min="0" max="1" step="0.05"><span id="scMusicVolumeVal">70%</span></div>
        <div class="sc-settings">
          <div class="field"><label>Crossfade (s)</label><input id="scCrossfade" type="number" min="0" max="5" step="0.1"></div>
          <div class="field"><label>Volumen mientras habla A2</label><input id="scDuckSpeak" type="number" min="0" max="1" step="0.05"></div>
          <div class="field"><label>Volumen con cliente/cara</label><input id="scDuckFace" type="number" min="0" max="1" step="0.05"></div>
        </div>
        <div class="sc-check"><input id="scRepeat" type="checkbox"><label for="scRepeat">Repetir la lista completa al terminar</label></div>
        <div class="sc-check"><input id="scPlayOnSitu" type="checkbox"><label for="scPlayOnSitu">Al pulsar una situación, cambiar a su canción asociada</label></div>
        <div class="sc-playlist" id="scPlaylist"></div>
        <details class="sc-details" id="scExcludedDetails"><summary id="scExcludedSummary">Canciones excluidas (0)</summary><div id="scExcluded"></div></details>
      </details>
    </div>
  </div>`;
  $('scExpand').onclick=()=>{expanded=!expanded;$('scBody').classList.toggle('open',expanded);$('scExpand').textContent=expanded?'▴':'▾'};
  $('scA2Quick').onclick=()=>{expanded=true;$('scBody').classList.add('open');$('scExpand').textContent='▴';$('scSituPrimary')?.scrollIntoView({block:'nearest'})};
  $('scSituMore').onclick=()=>{moreSituations=!moreSituations;$('scSituExtra').style.display=moreSituations?'grid':'none';$('scSituMore').textContent=moreSituations?'Ocultar adicionales':'⋯ Más situaciones'};
  $('scAutoJack').checked=autoJack;$('scAutoJack').onchange=e=>{autoJack=!!e.target.checked;localStorage.setItem(A2_AUTO_JACK_KEY,autoJack?'1':'0')};
  document.querySelectorAll('[data-jack]').forEach(b=>b.onclick=()=>sendCommand('jack_level',{level:b.dataset.jack}));
  $('scJackReplay').onclick=()=>{if(lastJackLevel)sendCommand('jack_level',{level:lastJackLevel})};
  $('scPickFolder').onclick=()=>$('scFolderInput').click();$('scPickFiles').onclick=()=>$('scFilesInput').click();
  $('scFolderInput').onchange=e=>loadFiles(e.target.files);$('scFilesInput').onchange=e=>loadFiles(e.target.files);
  $('scPlay').onclick=togglePlay;$('scNext').onclick=()=>nextTrack(true);
  $('scShuffle').onclick=()=>{musicCfg.shuffle=!musicCfg.shuffle;saveMusicCfg();paintMusicSettings()};
  $('scMusicVolume').oninput=e=>{musicCfg.volume=clamp(e.target.value,0,1);saveMusicCfg();$('scMusicVolumeVal').textContent=Math.round(musicCfg.volume*100)+'%';applyDeckVolumes()};
  $('scCrossfade').onchange=e=>{musicCfg.crossfade=clamp(e.target.value,0,5);saveMusicCfg();e.target.value=musicCfg.crossfade.toFixed(1)};
  $('scDuckSpeak').onchange=e=>{musicCfg.duckSpeaking=clamp(e.target.value,0,1);saveMusicCfg();updateDuckTarget()};
  $('scDuckFace').onchange=e=>{musicCfg.duckFace=clamp(e.target.value,0,1);saveMusicCfg();updateDuckTarget()};
  $('scRepeat').onchange=e=>{musicCfg.repeat=!!e.target.checked;saveMusicCfg()};
  $('scPlayOnSitu').onchange=e=>{musicCfg.playOnSituation=!!e.target.checked;saveMusicCfg()};
}

function refreshChannel(){
  const k=channelKey(), mount=$('seasonalControlsMount');if(!mount)return;
  if(!k){ if(currentChannel){stopMusic()} currentChannel='';mount.style.display='none';return; }
  if(k!==currentChannel){stopMusic();currentChannel=k;musicCfg=loadMusicCfg(k);playlist=[];currentPlaylistIndex=-1;rebuildPlaylist();paintMusicSettings();}
  mount.style.display='block';$('scSeason').textContent=channelLabel(k);renderSituations();paintA2();renderPlaylist();
}

async function connectFirebase(){
  try{
    const [{initializeApp},{getAuth,signInAnonymously,onAuthStateChanged},{getDatabase,ref,push,set,onValue}]=await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js')
    ]);
    const app=initializeApp(FIREBASE_CONFIG,'erp-seasonal-'+Math.random().toString(36).slice(2));
    const auth=getAuth(app),db=getDatabase(app);fb={auth,db,ref,push,set};
    onAuthStateChanged(auth,u=>{firebaseReady=!!u;paintA2()});
    await signInAnonymously(auth);
    onValue(ref(db,'.info/connected'),snap=>{firebaseConnected=!!snap.val();paintA2()});
    onValue(ref(db,`${ROOT}/devices/${DEVICE}/state`),snap=>{a2State=snap.val()||{};paintA2();updateDuckTarget()});
    onValue(ref(db,`${ROOT}/devices/${DEVICE}/config`),snap=>{const v=snap.val();if(v){a2Config=v;localStorage.setItem(A2_CACHE_KEY,JSON.stringify(v));renderSituations();renderPlaylist();paintA2()}});
  }catch(e){firebaseReady=false;firebaseConnected=false;paintA2();console.warn('A2/Firebase opcional no disponible',e)}
}
async function sendCommand(type,payload={},opts={}){
  if(!fb||!firebaseReady||!firebaseConnected||!a2State.online){if(!opts.silent)showMsg('A2 sin conexión');return null}
  try{const node=fb.push(fb.ref(fb.db,`${ROOT}/commands/${DEVICE}`)),t=Date.now();await fb.set(node,{type,target:DEVICE,createdAt:t,expiresAt:t+30000,payload});return node.key}catch(e){if(!opts.silent)showMsg('No se pudo enviar al A2');return null}
}
function paintA2(){
  const online=!!(firebaseReady&&firebaseConnected&&a2State.online);$('scA2Dot')?.classList.toggle('on',online);
  if($('scA2Text'))$('scA2Text').textContent=online?'online':'offline';if($('scFace'))$('scFace').textContent=a2State.facePresent?'cara':'sin cara';if($('scVoice'))$('scVoice').textContent=a2State.speaking?'hablando':'libre';
  const close=saleClosingConfig();if($('scSaleCloseMode'))$('scSaleCloseMode').textContent=close.mode==='auto'?`auto ${close.delaySec}s`:'manual';
  if($('scMiniStatus'))$('scMiniStatus').textContent=`📱 ${online?'A2 online':'A2 offline'} · ${a2State.speaking?'hablando':a2State.facePresent?'cliente':'libre'}`;
  document.querySelectorAll('[data-situ-sale],[data-jack]').forEach(b=>b.disabled=!online);
}
function renderSituations(){
  if(!$('scSituPrimary'))return;const pools=a2Config?.pools||{},keys=situationKeys();
  const primary=keys.filter(k=>pools[k]?.showInSales===true);
  const mk=k=>`<button class="btn-secondary" type="button" data-situ-sale="${k}">${escapeHtml(situationLabel(k))}</button>`;
  $('scSituPrimary').innerHTML=(primary.length?primary:keys.slice(0,4)).map(mk).join('')||'<div class="sc-sub">Aún no hay situaciones publicadas por el A2.</div>';
  const effectivePrimary=primary.length?primary:keys.slice(0,4),rest=keys.filter(k=>!effectivePrimary.includes(k));
  $('scSituExtra').innerHTML=rest.map(mk).join('');$('scSituMore').style.display=rest.length?'block':'none';if(!rest.length){moreSituations=false;$('scSituExtra').style.display='none'}
  document.querySelectorAll('[data-situ-sale]').forEach(b=>b.onclick=()=>runSituation(b.dataset.situSale));paintA2();
}
function escapeHtml(v){const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML}
function runSituation(name){
  const p=a2Config?.pools?.[name]||{},action=p.salesAction||'now';
  if(musicCfg?.playOnSituation)playAssociated(name);
  if(action==='context')sendCommand('context',{name,durationSec:Number(a2Config?.options?.contextDurationSec||45),nextOnly:false});
  else if(action==='next')sendCommand('context',{name,durationSec:Number(a2Config?.options?.contextDurationSec||45),nextOnly:true});
  else sendCommand('category',{name});
}

/* ---------------- Música local con lista programada + crossfade ---------------- */
const decks=[{el:new Audio(),gain:0,url:'',key:''},{el:new Audio(),gain:0,url:'',key:''}];
let activeDeck=-1,transitioning=false,duckCurrent=1,duckAnim=0;
decks.forEach((d,i)=>{d.el.preload='auto';d.el.addEventListener('timeupdate',()=>maybeAutoCrossfade(i));d.el.addEventListener('ended',()=>{if(i===activeDeck&&!transitioning)nextTrack(false)})});
function fileMap(){return currentChannel?channelFiles[currentChannel]:new Map()}
function loadFiles(fileList){
  if(!currentChannel)return;const map=new Map();for(const f of [...(fileList||[])]){if(!/^audio\//.test(f.type)&&!(/\.(mp3|m4a|ogg|wav|aac)$/i.test(f.name)))continue;map.set(trackKey(f),f)}channelFiles[currentChannel]=map;rebuildPlaylist();renderPlaylist();if(playlist.length){showMsg(`${map.size} archivos · ${playlist.length} posiciones en la lista`);if(activeDeck<0)$('scTrackTitle').textContent=prettyTrack(playlist[0])}}
function rebuildPlaylist(){
  if(!currentChannel||!musicCfg){playlist=[];return}
  const keys=[...fileMap().keys()].sort((a,b)=>a.localeCompare(b)), available=new Set(keys), excluded=new Set(musicCfg.excluded||[]);
  let seq=(musicCfg.sequence||[]).filter(k=>available.has(k)&&!excluded.has(k));
  if(!seq.length && !(musicCfg.sequence||[]).length) seq=keys.filter(k=>!excluded.has(k));
  const represented=new Set(seq);
  for(const k of keys) if(!excluded.has(k)&&!represented.has(k)){seq.push(k);represented.add(k)}
  playlist=[...seq];musicCfg.sequence=[...playlist];musicCfg.excluded=[...excluded];saveMusicCfg();
  if(currentPlaylistIndex>=playlist.length)currentPlaylistIndex=playlist.length-1;
}
function currentTrackKey(){return activeDeck>=0?decks[activeDeck].key:''}
async function togglePlay(){
  if(activeDeck>=0&&decks[activeDeck].key){const d=decks[activeDeck].el;if(!d.paused){decks.forEach(x=>x.el.pause());$('scPlay').textContent='▶';return}try{await d.play();$('scPlay').textContent='⏸'}catch(_){showMsg('El navegador requiere tocar ▶ para iniciar audio')}return}
  if(!playlist.length){showMsg('Primero carga la carpeta o archivos de música');return}await playTrackAt(0,false)
}
function chooseNextIndex(){
  if(!playlist.length)return -1;
  if(musicCfg.shuffle&&playlist.length>1){const choices=playlist.map((_,i)=>i).filter(i=>i!==currentPlaylistIndex);return choices[Math.floor(Math.random()*choices.length)]}
  const idx=currentPlaylistIndex>=0?currentPlaylistIndex:0;
  if(idx+1<playlist.length)return idx+1;
  return musicCfg.repeat?0:-1;
}
async function nextTrack(cross=true){const i=chooseNextIndex();if(i<0){decks.forEach(x=>x.el.pause());$('scPlay').textContent='▶';return}await playTrackAt(i,cross)}
async function playTrackAt(index,cross=true){
  index=Number(index);if(!Number.isInteger(index)||index<0||index>=playlist.length)return false;
  const key=playlist[index],file=fileMap().get(key);if(!file){showMsg('Vuelve a cargar la carpeta de música');return false}
  const sameOccurrence=activeDeck>=0&&currentPlaylistIndex===index&&decks[activeDeck].key===key;
  if(sameOccurrence){try{decks[activeDeck].el.currentTime=0;await decks[activeDeck].el.play();$('scPlay').textContent='⏸';return true}catch(_){return false}}
  const next=activeDeck===0?1:0,d=decks[next];if(d.url)URL.revokeObjectURL(d.url);d.url=URL.createObjectURL(file);d.key=key;d.el.src=d.url;d.el.currentTime=0;d.gain=(activeDeck<0||!cross||musicCfg.crossfade<=0)?1:0;applyDeckVolumes();
  try{await d.el.play()}catch(e){URL.revokeObjectURL(d.url);d.url='';d.key='';showMsg('No se pudo iniciar la canción; toca ▶ y prueba otra vez');return false}
  currentPlaylistIndex=index;$('scPlay').textContent='⏸';$('scTrackTitle').textContent=prettyTrack(key);
  if(activeDeck<0||!cross||musicCfg.crossfade<=0){if(activeDeck>=0)stopDeck(activeDeck);activeDeck=next;d.gain=1;applyDeckVolumes();renderPlaylist();return true}
  const old=activeDeck,oldDeck=decks[old],duration=Math.max(.05,Number(musicCfg.crossfade)||1.5)*1000,start=performance.now();transitioning=true;activeDeck=next;
  const step=now=>{const q=Math.min(1,(now-start)/duration);d.gain=q;oldDeck.gain=1-q;applyDeckVolumes();if(q<1)requestAnimationFrame(step);else{stopDeck(old);d.gain=1;transitioning=false;applyDeckVolumes();renderPlaylist()}};requestAnimationFrame(step);renderPlaylist();return true
}
function stopDeck(i){const d=decks[i];try{d.el.pause();d.el.removeAttribute('src');d.el.load()}catch(_){}if(d.url){URL.revokeObjectURL(d.url);d.url=''}d.key='';d.gain=0}
function stopMusic(){decks.forEach((_,i)=>stopDeck(i));activeDeck=-1;currentPlaylistIndex=-1;transitioning=false;if($('scPlay'))$('scPlay').textContent='▶';if($('scTrackTitle'))$('scTrackTitle').textContent='Música sin cargar'}
function maybeAutoCrossfade(i){if(i!==activeDeck||transitioning||musicCfg?.crossfade<=0)return;const el=decks[i].el;if(!Number.isFinite(el.duration)||el.duration<=0)return;const remain=el.duration-el.currentTime;if(remain>0&&remain<=Number(musicCfg.crossfade)+.12){const next=chooseNextIndex();if(next>=0)playTrackAt(next,true)}}
function duckTarget(){if(a2State.speaking)return clamp(musicCfg?.duckSpeaking??.15,0,1);if(a2State.facePresent)return clamp(musicCfg?.duckFace??.55,0,1);return 1}
function updateDuckTarget(){const target=duckTarget(),from=duckCurrent,start=performance.now(),dur=350;if(duckAnim)cancelAnimationFrame(duckAnim);const step=now=>{const q=Math.min(1,(now-start)/dur);duckCurrent=from+(target-from)*q;applyDeckVolumes();if(q<1)duckAnim=requestAnimationFrame(step)};duckAnim=requestAnimationFrame(step)}
function applyDeckVolumes(){if(!musicCfg)return;for(const d of decks)d.el.volume=clamp(Number(musicCfg.volume||0)*duckCurrent*d.gain,0,1)}
function playAssociated(situ){const key=musicCfg?.associations?.[situ];if(!key)return;const i=playlist.findIndex(k=>k===key);if(i>=0&&fileMap().has(key))playTrackAt(i,true)}
function paintMusicSettings(){
  if(!musicCfg||!$('scMusicVolume'))return;
  $('scMusicVolume').value=musicCfg.volume;$('scMusicVolumeVal').textContent=Math.round(musicCfg.volume*100)+'%';$('scCrossfade').value=Number(musicCfg.crossfade).toFixed(1);$('scDuckSpeak').value=musicCfg.duckSpeaking;$('scDuckFace').value=musicCfg.duckFace;$('scPlayOnSitu').checked=musicCfg.playOnSituation;$('scRepeat').checked=musicCfg.repeat!==false;
  $('scShuffle').textContent=musicCfg.shuffle?'🔀 Aleatorio':'☰ Programada';updateDuckTarget()
}
function moveEntry(index,delta){
  index=Number(index);const j=index+delta;if(index<0||j<0||index>=playlist.length||j>=playlist.length)return;
  [playlist[index],playlist[j]]=[playlist[j],playlist[index]];
  if(currentPlaylistIndex===index)currentPlaylistIndex=j;else if(currentPlaylistIndex===j)currentPlaylistIndex=index;
  musicCfg.sequence=[...playlist];saveMusicCfg();renderPlaylist()
}
function duplicateEntry(index){
  index=Number(index);if(index<0||index>=playlist.length)return;playlist.splice(index+1,0,playlist[index]);if(currentPlaylistIndex>index)currentPlaylistIndex++;musicCfg.sequence=[...playlist];saveMusicCfg();renderPlaylist()
}
function removeEntry(index){
  index=Number(index);if(index<0||index>=playlist.length)return;const key=playlist[index],count=playlist.filter(k=>k===key).length;
  playlist.splice(index,1);
  if(count===1){const ex=new Set(musicCfg.excluded||[]);ex.add(key);musicCfg.excluded=[...ex]}
  if(currentPlaylistIndex>index)currentPlaylistIndex--;else if(currentPlaylistIndex===index)currentPlaylistIndex=Math.min(index,playlist.length-1);
  musicCfg.sequence=[...playlist];saveMusicCfg();renderPlaylist()
}
function restoreExcluded(key){
  const ex=new Set(musicCfg.excluded||[]);ex.delete(key);musicCfg.excluded=[...ex];if(fileMap().has(key))playlist.push(key);musicCfg.sequence=[...playlist];saveMusicCfg();renderPlaylist()
}
function setAssociation(key,situ){for(const [s,k] of Object.entries(musicCfg.associations||{}))if(k===key)delete musicCfg.associations[s];if(situ)musicCfg.associations[situ]=key;saveMusicCfg();renderPlaylist()}
function renderPlaylist(){
  const host=$('scPlaylist');if(!host||!musicCfg)return;const situ=situationKeys();
  if(!playlist.length)host.innerHTML='<div class="sc-sub">No hay canciones activas en esta sesión.</div>';
  else host.innerHTML=playlist.map((k,i)=>{const assigned=Object.entries(musicCfg.associations||{}).find(([,v])=>v===k)?.[0]||'';return `<div class="sc-song"><div class="sc-song-num">${String(i+1).padStart(2,'0')}</div><div class="sc-song-name">${currentPlaylistIndex===i?'▶ ':''}${escapeHtml(prettyTrack(k))}</div><div class="sc-song-tools"><button class="btn-secondary" data-play-index="${i}" type="button" title="Reproducir">▶</button><button class="btn-secondary" data-up-index="${i}" type="button" ${i===0?'disabled':''} title="Subir">↑</button><button class="btn-secondary" data-down-index="${i}" type="button" ${i===playlist.length-1?'disabled':''} title="Bajar">↓</button><button class="btn-secondary" data-dup-index="${i}" type="button" title="Repetir este archivo justo después">＋</button><button class="btn-secondary" data-remove-index="${i}" type="button" title="Quitar esta aparición; si es la única, excluir canción">−</button></div><select data-assoc-song="${encodeURIComponent(k)}"><option value="">Sin situación asociada</option>${situ.map(s=>`<option value="${s}" ${assigned===s?'selected':''}>${escapeHtml(situationLabel(s))}</option>`).join('')}</select></div>`}).join('');
  host.querySelectorAll('[data-play-index]').forEach(b=>b.onclick=()=>playTrackAt(Number(b.dataset.playIndex),true));
  host.querySelectorAll('[data-up-index]').forEach(b=>b.onclick=()=>moveEntry(Number(b.dataset.upIndex),-1));
  host.querySelectorAll('[data-down-index]').forEach(b=>b.onclick=()=>moveEntry(Number(b.dataset.downIndex),1));
  host.querySelectorAll('[data-dup-index]').forEach(b=>b.onclick=()=>duplicateEntry(Number(b.dataset.dupIndex)));
  host.querySelectorAll('[data-remove-index]').forEach(b=>b.onclick=()=>removeEntry(Number(b.dataset.removeIndex)));
  host.querySelectorAll('[data-assoc-song]').forEach(sel=>sel.onchange=()=>setAssociation(decodeURIComponent(sel.dataset.assocSong),sel.value));
  const excluded=[...(musicCfg.excluded||[])];$('scExcludedSummary').textContent=`Canciones excluidas (${excluded.length})`;
  $('scExcluded').innerHTML=excluded.length?excluded.map(k=>`<div class="sc-excluded-row"><span>${escapeHtml(prettyTrack(k))}</span><button class="btn-secondary" data-restore-song="${encodeURIComponent(k)}" type="button">Restaurar</button></div>`).join(''):'<div class="sc-sub">Ninguna.</div>';
  $('scExcluded').querySelectorAll('[data-restore-song]').forEach(b=>b.onclick=()=>restoreExcluded(decodeURIComponent(b.dataset.restoreSong)));
}

/* ---------------- Cierre de venta / cola simple del A2 ---------------- */
async function waitForSpeechStart(maxMs=2200){const end=Date.now()+maxMs;while(Date.now()<end){if(a2State.speaking)return true;await sleep(120)}return false}
async function waitUntilA2Idle(maxMs=30000){const end=Date.now()+maxMs;while(Date.now()<end&&a2State.speaking)await sleep(180)}
async function scheduleSaleClosing(detail={}){
  const cfg=saleClosingConfig();if(cfg.mode!=='auto')return;
  const saleId=String(detail.ventaId||`anon-${Date.now()}`);if(saleClosingJobs.has(saleId))return;saleClosingJobs.add(saleId);
  try{
    const jackAt=jackSaleActivity.get(saleId)||0;
    if(jackAt && Date.now()-jackAt<15000){
      const started=await waitForSpeechStart(2400);if(started)await waitUntilA2Idle(35000);
    }
    if(cfg.delaySec>0)await sleep(cfg.delaySec*1000);
    if(a2State.speaking)await waitUntilA2Idle(20000);
    await sendCommand('category',{name:cfg.pool},{silent:true});
  }finally{
    setTimeout(()=>saleClosingJobs.delete(saleId),3000);
    jackSaleActivity.delete(saleId);
  }
}
function handleJackEvent(ev){
  const d=ev.detail||{};
  if(d.type==='subio_nivel'&&d.despues){
    lastJackLevel=String(d.despues).toUpperCase();
    if($('scJackAlertText'))$('scJackAlertText').textContent=`🔥 Jack subió a ${lastJackLevel} · acumulado $${Number(d.acumulado||0).toFixed(0)}`;$('scJackAlert')?.classList.add('show');
    if(autoJack&&!d.retroactivo){
      if(d.ventaId)jackSaleActivity.set(String(d.ventaId),Date.now());
      sendCommand('jack_level',{level:lastJackLevel},{silent:true});
    }
    return;
  }
  if(d.type==='venta_finalizada'&&!d.retroactivo)scheduleSaleClosing(d);
}
function handleNormalSaleCompleted(ev){
  const d=ev.detail||{},canal=String(d.sessionCanal||d.canal||'').trim().toLowerCase();
  if(canal==='dia de muertos')scheduleSaleClosing(d);
}

function init(){
  injectStyle();injectUI();currentChannel=channelKey();if(currentChannel){musicCfg=loadMusicCfg(currentChannel);rebuildPlaylist();paintMusicSettings()}
  refreshChannel();document.addEventListener('rv:session-changed',refreshChannel);$('canalSelect')?.addEventListener('change',refreshChannel);
  document.addEventListener('hw:event',handleJackEvent);document.addEventListener('rv:sale-completed',handleNormalSaleCompleted);connectFirebase();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
