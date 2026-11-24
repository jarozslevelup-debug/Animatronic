/* seasonal_controls.js — reproductor compacto + controles estacionales para Ventas.
 * v3
 * - Música disponible en Halloween / Día de Muertos / Tianguis / TianguisNav, con visibilidad desde Opciones.
 * - Animatrónico A2 sigue limitado a los modos estacionales.
 * - Reproductor local: anterior/play/siguiente, progreso, lista programada, aleatorio inteligente, prioridad, descanso temporal, historial y reanudación.
 * - Firebase/A2 es opcional: nunca bloquea ventas ni el reproductor local.
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
const MUSIC_SESSION_PREFIX='erp_season_music_session_v1_';
const MUSIC_VISIBILITY_KEY='rv_show_music_player';
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,Number(v)||0));
const safeJson=(s,fallback)=>{try{return JSON.parse(s)}catch(_){return fallback}};
const showMsg=msg=>{ if(typeof window.showToast==='function') window.showToast(msg); else console.log(msg); };
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

let fb=null, firebaseReady=false, firebaseConnected=false, a2State={}, a2Config=safeJson(localStorage.getItem(A2_CACHE_KEY)||'null',null);
let currentChannel='', expanded=false, moreSituations=false;
let autoJack=localStorage.getItem(A2_AUTO_JACK_KEY)==='1', lastJackLevel='';
let channelFiles={halloween:new Map(),dia_de_muertos:new Map(),tianguis:new Map(),tianguisnav:new Map()};
let musicCfg=null, musicSession=null, playlist=[], currentPlaylistIndex=-1;
const saleClosingJobs=new Set(), jackSaleActivity=new Map();

function channelKey(){
  const v=String($('canalSelect')?.value||'').trim().toLowerCase();
  if(v==='halloween')return 'halloween';
  if(v==='dia de muertos')return 'dia_de_muertos';
  if(v==='tianguis')return 'tianguis';
  if(v==='tianguisnav')return 'tianguisnav';
  return '';
}
function isSeasonalChannel(k=currentChannel){return k==='halloween'||k==='dia_de_muertos'}
function musicVisible(){return localStorage.getItem(MUSIC_VISIBILITY_KEY)!=='false'}
function channelLabel(k){
  if(k==='halloween')return '🎃 Halloween';
  if(k==='dia_de_muertos')return '💀 Día de Muertos';
  if(k==='tianguisnav')return '🎄 TianguisNav';
  if(k==='tianguis')return '⛺ Tianguis';
  return '🎵 Música';
}
function musicDefaults(){return {volume:.70,crossfade:1.5,duckSpeaking:.15,duckFace:.55,playOnSituation:true,shuffle:false,repeat:true,sequence:[],excluded:[],priority:[],associations:{}}}
function musicSessionDefaults(){return {played:[],rested:[],history:[],round:1,currentKey:'',currentTime:0,updatedAt:0}}
function loadMusicCfg(k){
  const x=safeJson(localStorage.getItem(MUSIC_PREFIX+k)||'null',null)||{};
  const old=safeJson(localStorage.getItem('erp_season_music_v1_'+k)||'null',null)||{};
  const src=Object.keys(x).length?x:old;
  const seq=Array.isArray(src.sequence)?src.sequence:(Array.isArray(src.order)?src.order:[]);
  return {...musicDefaults(),...src,sequence:[...seq],excluded:Array.isArray(src.excluded)?[...src.excluded]:[],priority:Array.isArray(src.priority)?[...src.priority]:[],associations:{...(src.associations||{})}};
}
function loadMusicSession(k){
  const src=safeJson(localStorage.getItem(MUSIC_SESSION_PREFIX+k)||'null',null)||{};
  const merged={...musicSessionDefaults(),...src,played:Array.isArray(src.played)?[...src.played]:[],rested:Array.isArray(src.rested)?[...src.rested]:[],history:Array.isArray(src.history)?[...src.history]:[]};
  if(merged.updatedAt && Date.now()-Number(merged.updatedAt)>18*3600000)return musicSessionDefaults();
  return merged;
}
function saveMusicCfg(){if(!currentChannel||!musicCfg)return;localStorage.setItem(MUSIC_PREFIX+currentChannel,JSON.stringify(musicCfg))}
function saveMusicSession(){if(!currentChannel||!musicSession)return;musicSession.updatedAt=Date.now();localStorage.setItem(MUSIC_SESSION_PREFIX+currentChannel,JSON.stringify(musicSession))}
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
  .sc-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.10)}
  .sc-mini{display:flex;align-items:center;gap:6px;padding:9px 9px 6px;min-width:0}
  .sc-season{font-size:11px;font-weight:800;white-space:nowrap}.sc-track{min-width:0;flex:1}.sc-track b{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sc-track small{display:block;color:var(--text-muted);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sc-iconbtn{border:1px solid var(--border);background:var(--surface-2);color:var(--text);border-radius:999px;min-width:38px;height:38px;padding:5px 8px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;gap:4px}.sc-iconbtn:disabled{opacity:.38}.sc-iconbtn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);min-width:42px;height:42px;font-size:16px}
  .sc-a2-label{font-size:9px;font-weight:900}.sc-dot{width:8px;height:8px;border-radius:50%;background:var(--danger);display:inline-block}.sc-dot.on{background:var(--ok)}
  .sc-progressline{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center;padding:0 10px 8px}.sc-progressline input{width:100%;accent-color:var(--accent);height:18px}.sc-progressline span{font-size:9px;color:var(--text-muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  .sc-body{display:none;padding:0 10px 10px}.sc-body.open{display:block}.sc-details{border-top:1px solid var(--border);padding-top:8px;margin-top:3px}.sc-details summary{cursor:pointer;font-weight:800;font-size:12px;padding:5px 0}
  .sc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:6px;margin-top:7px}.sc-grid button{min-width:0;white-space:normal}
  .sc-sub{font-size:10px;color:var(--text-muted);line-height:1.45;margin-top:5px}.sc-status{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:10px;color:var(--text-muted);margin-top:5px}.sc-status b{color:var(--text)}
  .sc-alert{display:none;margin-top:8px;padding:8px;border:1px solid var(--accent);border-radius:9px;background:var(--surface-2);align-items:center;gap:8px}.sc-alert.show{display:flex}.sc-alert span{flex:1;font-size:11px}
  .sc-music-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.sc-music-actions button{flex:1 1 105px}
  .sc-range{display:grid;grid-template-columns:1fr 48px;gap:7px;align-items:center;margin-top:7px}.sc-range input{width:100%;accent-color:var(--accent)}.sc-range span{text-align:right;font-size:10px;color:var(--text-muted)}
  .sc-roundbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;padding:7px 8px;border-radius:9px;background:var(--surface-2);font-size:10px;color:var(--text-muted)}.sc-roundbar b{color:var(--text)}.sc-roundbar button{padding:5px 8px;font-size:10px}
  .sc-playlist{margin-top:8px}.sc-song{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:6px;padding:9px 7px;border-top:1px solid var(--border);align-items:center;border-radius:9px;transition:opacity .15s,background .15s}.sc-song:first-child{border-top:0}.sc-song.current{background:var(--surface-2);box-shadow:inset 3px 0 0 var(--accent)}.sc-song.played:not(.current){opacity:.48}.sc-song.resting{opacity:.32}.sc-song.resting .sc-song-name{text-decoration:line-through}.sc-song-num{font-size:10px;color:var(--text-muted);text-align:center}.sc-song-name{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:650}.sc-song-badges{font-size:9px;color:var(--text-muted);margin-top:2px}.sc-song-headtools{display:flex;gap:3px}.sc-song-headtools button{border:0;background:transparent;color:var(--text-muted);font-size:16px;padding:4px;min-width:28px}.sc-song-headtools button.active{color:var(--accent)}
  .sc-song-tools{grid-column:1/-1;display:flex;gap:4px;align-items:center;flex-wrap:wrap}.sc-song-tools button{padding:4px 7px;min-width:31px}.sc-song select{grid-column:1/-1;font-size:11px;padding:7px}
  .sc-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:8px}.sc-settings .field{min-width:0}.sc-settings label{font-size:9px;color:var(--text-muted)}
  .sc-check{display:flex;align-items:center;gap:7px;margin-top:8px;font-size:11px}.sc-check input{width:auto}
  .sc-excluded-row,.sc-history-row{display:flex;align-items:center;gap:7px;padding:6px 0;border-top:1px solid var(--border);font-size:10px}.sc-excluded-row span,.sc-history-row span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sc-history-row small{color:var(--text-muted)}
  @media(max-width:430px){.sc-season{display:none}.sc-settings{grid-template-columns:1fr}.sc-mini{gap:4px}.sc-iconbtn{min-width:34px;height:34px;padding:4px 6px}.sc-iconbtn.primary{min-width:39px;height:39px}.sc-a2-label{display:none}.sc-track b{font-size:11px}}
  `;document.head.appendChild(st);
}

function injectUI(){
  const mount=$('seasonalControlsMount');if(!mount)return;
  mount.innerHTML=`<div class="sc-card">
    <div class="sc-mini">
      <div class="sc-season" id="scSeason">🎵</div>
      <div class="sc-track"><b id="scTrackTitle">Música sin cargar</b><small id="scMiniStatus">Selecciona carpeta cuando quieras reproducir</small></div>
      <button class="sc-iconbtn" id="scPrev" type="button" title="Anterior / reiniciar canción">⏮</button>
      <button class="sc-iconbtn primary" id="scPlay" type="button" title="Reproducir / pausa">▶</button>
      <button class="sc-iconbtn" id="scNext" type="button" title="Siguiente">⏭</button>
      <button class="sc-iconbtn" id="scA2Quick" type="button" title="Estado del Redmi A2 / animatrónico"><span class="sc-a2-label">A2</span><span id="scA2Dot" class="sc-dot"></span></button>
      <button class="sc-iconbtn" id="scExpand" type="button" title="Mostrar controles">▾</button>
    </div>
    <div class="sc-progressline" id="scProgressLine"><input id="scProgress" type="range" min="0" max="1000" step="1" value="0" aria-label="Progreso de la canción"><span id="scTime">0:00 / --:--</span></div>
    <div class="sc-body" id="scBody">
      <details class="sc-details" id="scAnimatronicDetails" open><summary>🎭 Animatrónico · controles rápidos</summary>
        <div class="sc-status"><span>📱 <b id="scA2Text">A2 offline</b></span><span>👤 <b id="scFace">sin cara</b></span><span>🔊 <b id="scVoice">libre</b></span><span>👋 <b id="scSaleCloseMode">cierre —</b></span></div>
        <div id="scSituPrimary" class="sc-grid"></div>
        <button class="btn-secondary btn-block" id="scSituMore" type="button" style="display:none;margin-top:6px;">⋯ Más situaciones</button>
        <div id="scSituExtra" class="sc-grid" style="display:none;"></div>
        <div class="sc-sub">El indicador A2 de arriba es rojo cuando el animatrónico está desconectado y verde cuando está en línea.</div>
        <div class="sc-alert" id="scJackAlert"><span id="scJackAlertText">Jack subió de nivel</span><button class="btn-secondary" id="scJackReplay" type="button">▶</button></div>
        <div class="sc-check"><input id="scAutoJack" type="checkbox"><label for="scAutoJack">Disparar automáticamente el audio al subir de nivel Jack</label></div>
        <div class="sc-grid"><button class="btn-secondary" data-jack="N1" type="button">Jack N1</button><button class="btn-secondary" data-jack="N2" type="button">Jack N2</button><button class="btn-secondary" data-jack="N3" type="button">Jack N3</button><button class="btn-secondary" data-jack="N4" type="button">Jack N4</button></div>
      </details>
      <details class="sc-details" id="scMusicDetails"><summary>🎵 Música del puesto</summary>
        <div class="sc-music-actions"><button class="btn-secondary" id="scPickFolder" type="button">📂 Cargar carpeta</button><button class="btn-secondary" id="scPickFiles" type="button">🎵 Elegir archivos</button><button class="btn-secondary" id="scShuffle" type="button">☰ Programada</button></div>
        <input id="scFolderInput" type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav" multiple webkitdirectory directory style="display:none">
        <input id="scFilesInput" type="file" accept="audio/*,.mp3,.m4a,.ogg,.wav" multiple style="display:none">
        <div class="sc-sub" id="scMusicLoadHint">La lista, orden, repeticiones, excluidas y prioridades se guardan. El navegador puede pedir volver a seleccionar la carpeta para recuperar los archivos físicos.</div>
        <div class="sc-range"><input id="scMusicVolume" type="range" min="0" max="1" step="0.05"><span id="scMusicVolumeVal">70%</span></div>
        <div class="sc-settings">
          <div class="field"><label>Crossfade (s)</label><input id="scCrossfade" type="number" min="0" max="5" step="0.1"></div>
          <div class="field"><label>Volumen mientras habla A2</label><input id="scDuckSpeak" type="number" min="0" max="1" step="0.05"></div>
          <div class="field"><label>Volumen con cliente/cara</label><input id="scDuckFace" type="number" min="0" max="1" step="0.05"></div>
        </div>
        <div class="sc-check"><input id="scRepeat" type="checkbox"><label for="scRepeat">Repetir la lista completa al terminar</label></div>
        <div class="sc-check" id="scPlayOnSituRow"><input id="scPlayOnSitu" type="checkbox"><label for="scPlayOnSitu">Al pulsar una situación, cambiar a su canción asociada</label></div>
        <div class="sc-roundbar"><span id="scRoundStatus"><b>0/0</b> · ronda 1</span><button class="btn-secondary" id="scResetRound" type="button">↻ Nueva ronda</button></div>
        <div class="sc-playlist" id="scPlaylist"></div>
        <details class="sc-details" id="scHistoryDetails"><summary id="scHistorySummary">Historial reciente (0)</summary><div id="scHistory"></div></details>
        <details class="sc-details" id="scExcludedDetails"><summary id="scExcludedSummary">Canciones excluidas (0)</summary><div id="scExcluded"></div></details>
      </details>
    </div>
  </div>`;
  $('scExpand').onclick=()=>{expanded=!expanded;$('scBody').classList.toggle('open',expanded);$('scExpand').textContent=expanded?'▴':'▾'};
  $('scA2Quick').onclick=()=>{expanded=true;$('scBody').classList.add('open');$('scExpand').textContent='▴';$('scAnimatronicDetails')?.scrollIntoView({block:'nearest'})};
  $('scSituMore').onclick=()=>{moreSituations=!moreSituations;$('scSituExtra').style.display=moreSituations?'grid':'none';$('scSituMore').textContent=moreSituations?'Ocultar adicionales':'⋯ Más situaciones'};
  $('scAutoJack').checked=autoJack;$('scAutoJack').onchange=e=>{autoJack=!!e.target.checked;localStorage.setItem(A2_AUTO_JACK_KEY,autoJack?'1':'0')};
  document.querySelectorAll('[data-jack]').forEach(b=>b.onclick=()=>sendCommand('jack_level',{level:b.dataset.jack}));
  $('scJackReplay').onclick=()=>{if(lastJackLevel)sendCommand('jack_level',{level:lastJackLevel})};
  $('scPickFolder').onclick=()=>$('scFolderInput').click();$('scPickFiles').onclick=()=>$('scFilesInput').click();
  $('scFolderInput').onchange=e=>loadFiles(e.target.files);$('scFilesInput').onchange=e=>loadFiles(e.target.files);
  $('scPlay').onclick=togglePlay;$('scPrev').onclick=previousTrack;$('scNext').onclick=()=>nextTrack(true,true);
  $('scProgress').oninput=e=>seekProgress(Number(e.target.value)||0);
  $('scResetRound').onclick=()=>resetRound(true);
  $('scShuffle').onclick=()=>{musicCfg.shuffle=!musicCfg.shuffle;saveMusicCfg();paintMusicSettings();renderPlaylist()};
  $('scMusicVolume').oninput=e=>{musicCfg.volume=clamp(e.target.value,0,1);saveMusicCfg();$('scMusicVolumeVal').textContent=Math.round(musicCfg.volume*100)+'%';applyDeckVolumes()};
  $('scCrossfade').onchange=e=>{musicCfg.crossfade=clamp(e.target.value,0,5);saveMusicCfg();e.target.value=musicCfg.crossfade.toFixed(1)};
  $('scDuckSpeak').onchange=e=>{musicCfg.duckSpeaking=clamp(e.target.value,0,1);saveMusicCfg();updateDuckTarget()};
  $('scDuckFace').onchange=e=>{musicCfg.duckFace=clamp(e.target.value,0,1);saveMusicCfg();updateDuckTarget()};
  $('scRepeat').onchange=e=>{musicCfg.repeat=!!e.target.checked;saveMusicCfg()};
  $('scPlayOnSitu').onchange=e=>{musicCfg.playOnSituation=!!e.target.checked;saveMusicCfg()};
}

function refreshChannel(){
  const k=channelKey(), mount=$('seasonalControlsMount');if(!mount)return;
  const seasonal=isSeasonalChannel(k), musicOn=musicVisible();
  if(!k||(!seasonal&&!musicOn)){if(currentChannel){stopMusic(true)}currentChannel='';mount.style.display='none';return}
  if(k!==currentChannel){if(currentChannel)stopMusic(true);currentChannel=k;musicCfg=loadMusicCfg(k);musicSession=loadMusicSession(k);playlist=[];currentPlaylistIndex=-1;rebuildPlaylist();paintMusicSettings()}
  if(!musicOn&&activeDeck>=0)stopMusic(true);
  mount.style.display='block';$('scSeason').textContent=channelLabel(k);
  if($('scAnimatronicDetails'))$('scAnimatronicDetails').style.display=seasonal?'block':'none';
  if($('scA2Quick'))$('scA2Quick').style.display=seasonal?'inline-flex':'none';
  if($('scMusicDetails'))$('scMusicDetails').style.display=musicOn?'block':'none';
  if($('scProgressLine'))$('scProgressLine').style.display=musicOn?'grid':'none';
  if($('scPlayOnSituRow'))$('scPlayOnSituRow').style.display=seasonal?'flex':'none';
  $('scPrev').style.display=musicOn?'inline-flex':'none';$('scPlay').style.display=musicOn?'inline-flex':'none';$('scNext').style.display=musicOn?'inline-flex':'none';
  if(seasonal){renderSituations();paintA2()}else updateMiniMusicStatus();
  renderPlaylist();updateProgressUI();
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
  if($('scA2Quick'))$('scA2Quick').title=`Redmi A2 / animatrónico: ${online?'conectado':'desconectado'}`;
  if($('scA2Text'))$('scA2Text').textContent=online?'online':'offline';if($('scFace'))$('scFace').textContent=a2State.facePresent?'cara':'sin cara';if($('scVoice'))$('scVoice').textContent=a2State.speaking?'hablando':'libre';
  const close=saleClosingConfig();if($('scSaleCloseMode'))$('scSaleCloseMode').textContent=close.mode==='auto'?`auto ${close.delaySec}s`:'manual';
  if(isSeasonalChannel()&&$('scMiniStatus'))$('scMiniStatus').textContent=`📱 ${online?'A2 online':'A2 offline'} · ${a2State.speaking?'hablando':a2State.facePresent?'cliente':'libre'}`;
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

/* ---------------- Música local · cola programada + controles modernos ---------------- */
const decks=[{el:new Audio(),gain:0,url:'',key:''},{el:new Audio(),gain:0,url:'',key:''}];
let activeDeck=-1,transitioning=false,crossfadeQueued=false,duckCurrent=1,duckAnim=0,lastProgressSave=0;
decks.forEach((d,i)=>{
  d.el.preload='auto';
  d.el.addEventListener('timeupdate',()=>{updateProgressUI();saveProgressThrottled();maybeAutoCrossfade(i)});
  d.el.addEventListener('ended',()=>{if(i===activeDeck&&!transitioning&&!crossfadeQueued){markPlayedKey(d.key);nextTrack(false,false)}});
  d.el.addEventListener('pause',()=>saveProgressThrottled(true));
});
function fileMap(){return currentChannel?channelFiles[currentChannel]:new Map()}
function formatTime(sec){if(!Number.isFinite(sec)||sec<0)return '--:--';const s=Math.floor(sec),m=Math.floor(s/60);return `${m}:${String(s%60).padStart(2,'0')}`}
function activeRested(){return new Set(musicSession?.rested||[])}
function activePlayed(){return new Set(musicSession?.played||[])}
function activePriority(){return new Set(musicCfg?.priority||[])}
function activeUniqueKeys(){const rest=activeRested();return [...new Set(playlist.filter(k=>!rest.has(k)))]}
function loadFiles(fileList){
  if(!currentChannel)return;const map=new Map();for(const f of [...(fileList||[])]){if(!/^audio\//.test(f.type)&&!(/\.(mp3|m4a|ogg|wav|aac)$/i.test(f.name)))continue;map.set(trackKey(f),f)}channelFiles[currentChannel]=map;rebuildPlaylist();renderPlaylist();
  if(playlist.length){const saved=musicSession?.currentKey,idx=saved?playlist.findIndex(k=>k===saved):-1;currentPlaylistIndex=idx>=0?idx:Math.max(0,currentPlaylistIndex);showMsg(`${map.size} archivos · ${playlist.length} posiciones en la lista`);if(activeDeck<0)$('scTrackTitle').textContent=idx>=0?`Continuar · ${prettyTrack(saved)}`:prettyTrack(playlist[0]);updateMiniMusicStatus()}
}
function rebuildPlaylist(){
  if(!currentChannel||!musicCfg){playlist=[];return}
  if(!musicSession)musicSession=loadMusicSession(currentChannel);
  const keys=[...fileMap().keys()].sort((a,b)=>a.localeCompare(b)),available=new Set(keys),excluded=new Set(musicCfg.excluded||[]);
  if(!keys.length){
    playlist=(musicCfg.sequence||[]).filter(k=>!excluded.has(k));
    if(musicSession.currentKey){const i=playlist.findIndex(k=>k===musicSession.currentKey);if(i>=0)currentPlaylistIndex=i}
    updateRoundStatus();return;
  }
  let seq=(musicCfg.sequence||[]).filter(k=>available.has(k)&&!excluded.has(k));
  if(!seq.length&&!(musicCfg.sequence||[]).length)seq=keys.filter(k=>!excluded.has(k));
  const represented=new Set(seq);for(const k of keys)if(!excluded.has(k)&&!represented.has(k)){seq.push(k);represented.add(k)}
  playlist=[...seq];musicCfg.sequence=[...playlist];musicCfg.excluded=[...excluded];musicCfg.priority=(musicCfg.priority||[]).filter(k=>available.has(k)&&!excluded.has(k));saveMusicCfg();
  musicSession.played=(musicSession.played||[]).filter(k=>available.has(k)&&!excluded.has(k));musicSession.rested=(musicSession.rested||[]).filter(k=>available.has(k)&&!excluded.has(k));musicSession.history=(musicSession.history||[]).filter(k=>available.has(k)).slice(-12);if(musicSession.currentKey&&!available.has(musicSession.currentKey)){musicSession.currentKey='';musicSession.currentTime=0}saveMusicSession();
  if(musicSession.currentKey){const i=playlist.findIndex(k=>k===musicSession.currentKey);if(i>=0)currentPlaylistIndex=i}else if(currentPlaylistIndex>=playlist.length)currentPlaylistIndex=playlist.length-1;
  updateRoundStatus();
}
function currentTrackKey(){return activeDeck>=0?decks[activeDeck].key:''}
function saveProgressThrottled(force=false){
  if(!musicSession)return;const now=Date.now();if(!force&&now-lastProgressSave<4000)return;lastProgressSave=now;
  if(activeDeck>=0&&decks[activeDeck].key){musicSession.currentKey=decks[activeDeck].key;musicSession.currentTime=Number(decks[activeDeck].el.currentTime)||0}saveMusicSession();
}
function updateProgressUI(){
  const el=activeDeck>=0?decks[activeDeck].el:null,p=$('scProgress'),t=$('scTime');if(!p||!t)return;
  if(!el||!Number.isFinite(el.duration)||el.duration<=0){p.value=0;t.textContent='0:00 / --:--';return}
  p.value=Math.round(clamp(el.currentTime/el.duration,0,1)*1000);t.textContent=`${formatTime(el.currentTime)} / ${formatTime(el.duration)}`;
}
function seekProgress(v){const el=activeDeck>=0?decks[activeDeck].el:null;if(!el||!Number.isFinite(el.duration)||el.duration<=0)return;el.currentTime=clamp(v,0,1000)/1000*el.duration;saveProgressThrottled(true);updateProgressUI()}
function updateMiniMusicStatus(){
  const active=activeUniqueKeys(),played=activePlayed(),done=active.filter(k=>played.has(k)).length,rest=activeRested().size,round=Math.max(1,Number(musicSession?.round)||1);
  if($('scMiniStatus')&&!isSeasonalChannel())$('scMiniStatus').textContent=`${done}/${active.length} sonaron · ronda ${round}${rest?` · ${rest} descanso`:''}`;
  updateRoundStatus();
}
function updateRoundStatus(){
  const active=activeUniqueKeys(),played=activePlayed(),done=active.filter(k=>played.has(k)).length,round=Math.max(1,Number(musicSession?.round)||1),rest=activeRested().size;
  if($('scRoundStatus'))$('scRoundStatus').innerHTML=`<b>${done}/${active.length}</b> · ronda ${round}${rest?` · ${rest} en descanso`:''}`;
}
function resetRound(increment=true){if(!musicSession)return;musicSession.played=[];if(increment)musicSession.round=Math.max(1,Number(musicSession.round)||1)+1;saveMusicSession();renderPlaylist();updateMiniMusicStatus()}
function markPlayedKey(key){if(!key||!musicSession)return;const set=activePlayed();set.add(key);musicSession.played=[...set];saveMusicSession();renderPlaylist();updateMiniMusicStatus()}
function markCurrentPlayedIfMeaningful(){if(activeDeck<0)return;const el=decks[activeDeck].el,key=decks[activeDeck].key;if(!key)return;const threshold=Number.isFinite(el.duration)&&el.duration>0?Math.min(30,Math.max(8,el.duration*.45)):20;if((Number(el.currentTime)||0)>=threshold)markPlayedKey(key)}
function pushHistory(key){if(!key||!musicSession)return;const h=musicSession.history||[];if(h[h.length-1]!==key)h.push(key);musicSession.history=h.slice(-12);saveMusicSession()}
async function togglePlay(){
  if(activeDeck>=0&&decks[activeDeck].key){const d=decks[activeDeck].el;if(!d.paused){decks.forEach(x=>x.el.pause());$('scPlay').textContent='▶';saveProgressThrottled(true);return}try{await d.play();$('scPlay').textContent='⏸'}catch(_){showMsg('El navegador requiere tocar ▶ para iniciar audio')}return}
  if(!playlist.length){showMsg('Primero carga la carpeta o archivos de música');return}
  const rest=activeRested();let idx=musicSession?.currentKey?playlist.findIndex(k=>k===musicSession.currentKey&&!rest.has(k)):-1;if(idx<0)idx=playlist.findIndex(k=>!rest.has(k));if(idx<0){showMsg('Todas las canciones están en descanso');return}await playTrackAt(idx,false,{resume:true})
}
function chooseNextIndex(){
  if(!playlist.length)return -1;const rest=activeRested(),eligible=playlist.map((k,i)=>({k,i})).filter(x=>!rest.has(x.k));if(!eligible.length)return -1;
  if(musicCfg.shuffle&&eligible.length>1){
    let choices=eligible.filter(x=>x.i!==currentPlaylistIndex),played=activePlayed(),fresh=choices.filter(x=>!played.has(x.k));
    if(!fresh.length){resetRound(true);fresh=choices}
    const priority=activePriority(),weighted=[];for(const x of fresh){const w=priority.has(x.k)?3:1;for(let n=0;n<w;n++)weighted.push(x)}return weighted[Math.floor(Math.random()*weighted.length)]?.i??fresh[0]?.i??-1;
  }
  const start=currentPlaylistIndex>=0?currentPlaylistIndex:-1;for(let i=start+1;i<playlist.length;i++)if(!rest.has(playlist[i]))return i;
  if(!musicCfg.repeat)return -1;resetRound(true);for(let i=0;i<playlist.length;i++)if(!rest.has(playlist[i]))return i;return -1;
}
async function nextTrack(cross=true,manual=true){if(manual)markCurrentPlayedIfMeaningful();const i=chooseNextIndex();if(i<0){decks.forEach(x=>x.el.pause());$('scPlay').textContent='▶';saveProgressThrottled(true);return}await playTrackAt(i,cross)}
async function previousTrack(){
  const cur=activeDeck>=0?decks[activeDeck].el:null;if(cur&&(Number(cur.currentTime)||0)>4){cur.currentTime=0;saveProgressThrottled(true);updateProgressUI();return}
  if(!playlist.length)return;const rest=activeRested();
  if(musicCfg.shuffle&&(musicSession?.history||[]).length>1){const h=musicSession.history;h.pop();const prev=h[h.length-1],idx=playlist.findIndex(k=>k===prev&&!rest.has(k));musicSession.history=h;saveMusicSession();if(idx>=0){await playTrackAt(idx,true,{skipHistory:true});return}}
  const start=currentPlaylistIndex>=0?currentPlaylistIndex:0;for(let i=start-1;i>=0;i--)if(!rest.has(playlist[i])){await playTrackAt(i,true);return}if(musicCfg.repeat){for(let i=playlist.length-1;i>=0;i--)if(!rest.has(playlist[i])){await playTrackAt(i,true);return}}
}
async function playTrackAt(index,cross=true,opts={}){
  index=Number(index);if(!Number.isInteger(index)||index<0||index>=playlist.length)return false;const key=playlist[index],file=fileMap().get(key);if(!file){showMsg('Vuelve a cargar la carpeta de música');return false}
  const sameOccurrence=activeDeck>=0&&currentPlaylistIndex===index&&decks[activeDeck].key===key;
  if(sameOccurrence){try{decks[activeDeck].el.currentTime=0;await decks[activeDeck].el.play();$('scPlay').textContent='⏸';musicSession.currentKey=key;musicSession.currentTime=0;saveMusicSession();updateProgressUI();return true}catch(_){return false}}
  const next=activeDeck===0?1:0,d=decks[next];if(d.url)URL.revokeObjectURL(d.url);d.url=URL.createObjectURL(file);d.key=key;d.el.src=d.url;d.el.currentTime=0;d.gain=(activeDeck<0||!cross||musicCfg.crossfade<=0)?1:0;applyDeckVolumes();
  if(opts.resume&&musicSession?.currentKey===key&&Number(musicSession.currentTime)>0){const resume=Math.max(0,Number(musicSession.currentTime)||0);const setResume=()=>{try{if(Number.isFinite(d.el.duration)&&resume<d.el.duration-2)d.el.currentTime=resume}catch(_){}};if(d.el.readyState>=1)setResume();else d.el.addEventListener('loadedmetadata',setResume,{once:true})}
  try{await d.el.play()}catch(e){URL.revokeObjectURL(d.url);d.url='';d.key='';showMsg('No se pudo iniciar la canción; toca ▶ y prueba otra vez');return false}
  currentPlaylistIndex=index;$('scPlay').textContent='⏸';$('scTrackTitle').textContent=prettyTrack(key);musicSession.currentKey=key;musicSession.currentTime=Number(d.el.currentTime)||0;if(!opts.skipHistory)pushHistory(key);else saveMusicSession();
  if(activeDeck<0||!cross||musicCfg.crossfade<=0){if(activeDeck>=0)stopDeck(activeDeck);activeDeck=next;d.gain=1;applyDeckVolumes();renderPlaylist();updateProgressUI();updateMiniMusicStatus();return true}
  const old=activeDeck,oldDeck=decks[old],duration=Math.max(.05,Number(musicCfg.crossfade)||1.5)*1000,start=performance.now();transitioning=true;activeDeck=next;
  const step=now=>{const q=Math.min(1,(now-start)/duration);d.gain=q;oldDeck.gain=1-q;applyDeckVolumes();if(q<1)requestAnimationFrame(step);else{stopDeck(old);d.gain=1;transitioning=false;applyDeckVolumes();renderPlaylist();updateProgressUI()}};requestAnimationFrame(step);renderPlaylist();updateMiniMusicStatus();return true
}
function stopDeck(i){const d=decks[i];try{d.el.pause();d.el.removeAttribute('src');d.el.load()}catch(_){}if(d.url){URL.revokeObjectURL(d.url);d.url=''}d.key='';d.gain=0}
function stopMusic(preserve=true){if(preserve)saveProgressThrottled(true);decks.forEach((_,i)=>stopDeck(i));activeDeck=-1;transitioning=false;crossfadeQueued=false;if($('scPlay'))$('scPlay').textContent='▶';if($('scTrackTitle'))$('scTrackTitle').textContent=musicSession?.currentKey?`Continuar · ${prettyTrack(musicSession.currentKey)}`:'Música sin cargar';updateProgressUI()}
function maybeAutoCrossfade(i){if(i!==activeDeck||transitioning||crossfadeQueued||musicCfg?.crossfade<=0)return;const el=decks[i].el;if(!Number.isFinite(el.duration)||el.duration<=0)return;const remain=el.duration-el.currentTime;if(remain>0&&remain<=Number(musicCfg.crossfade)+.12){const next=chooseNextIndex();if(next>=0){crossfadeQueued=true;markPlayedKey(decks[i].key);playTrackAt(next,true).finally(()=>{crossfadeQueued=false})}}}
function duckTarget(){if(!isSeasonalChannel())return 1;if(a2State.speaking)return clamp(musicCfg?.duckSpeaking??.15,0,1);if(a2State.facePresent)return clamp(musicCfg?.duckFace??.55,0,1);return 1}
function updateDuckTarget(){const target=duckTarget(),from=duckCurrent,start=performance.now(),dur=350;if(duckAnim)cancelAnimationFrame(duckAnim);const step=now=>{const q=Math.min(1,(now-start)/dur);duckCurrent=from+(target-from)*q;applyDeckVolumes();if(q<1)duckAnim=requestAnimationFrame(step)};duckAnim=requestAnimationFrame(step)}
function applyDeckVolumes(){if(!musicCfg)return;for(const d of decks)d.el.volume=clamp(Number(musicCfg.volume||0)*duckCurrent*d.gain,0,1)}
function playAssociated(situ){const key=musicCfg?.associations?.[situ];if(!key)return;const i=playlist.findIndex(k=>k===key);if(i>=0&&fileMap().has(key))playTrackAt(i,true)}
function paintMusicSettings(){
  if(!musicCfg||!$('scMusicVolume'))return;$('scMusicVolume').value=musicCfg.volume;$('scMusicVolumeVal').textContent=Math.round(musicCfg.volume*100)+'%';$('scCrossfade').value=Number(musicCfg.crossfade).toFixed(1);$('scDuckSpeak').value=musicCfg.duckSpeaking;$('scDuckFace').value=musicCfg.duckFace;$('scPlayOnSitu').checked=musicCfg.playOnSituation;$('scRepeat').checked=musicCfg.repeat!==false;$('scShuffle').textContent=musicCfg.shuffle?'🔀 Aleatorio inteligente':'☰ Programada';updateDuckTarget();updateMiniMusicStatus()
}
function moveEntry(index,delta){index=Number(index);const j=index+delta;if(index<0||j<0||index>=playlist.length||j>=playlist.length)return;[playlist[index],playlist[j]]=[playlist[j],playlist[index]];if(currentPlaylistIndex===index)currentPlaylistIndex=j;else if(currentPlaylistIndex===j)currentPlaylistIndex=index;musicCfg.sequence=[...playlist];saveMusicCfg();renderPlaylist()}
function duplicateEntry(index){index=Number(index);if(index<0||index>=playlist.length)return;playlist.splice(index+1,0,playlist[index]);if(currentPlaylistIndex>index)currentPlaylistIndex++;musicCfg.sequence=[...playlist];saveMusicCfg();renderPlaylist()}
function removeEntry(index){index=Number(index);if(index<0||index>=playlist.length)return;const key=playlist[index],count=playlist.filter(k=>k===key).length;playlist.splice(index,1);if(count===1){const ex=new Set(musicCfg.excluded||[]);ex.add(key);musicCfg.excluded=[...ex];musicCfg.priority=(musicCfg.priority||[]).filter(k=>k!==key);musicSession.played=(musicSession.played||[]).filter(k=>k!==key);musicSession.rested=(musicSession.rested||[]).filter(k=>k!==key)}if(currentPlaylistIndex>index)currentPlaylistIndex--;else if(currentPlaylistIndex===index)currentPlaylistIndex=Math.min(index,playlist.length-1);musicCfg.sequence=[...playlist];saveMusicCfg();saveMusicSession();renderPlaylist();updateMiniMusicStatus()}
function restoreExcluded(key){const ex=new Set(musicCfg.excluded||[]);ex.delete(key);musicCfg.excluded=[...ex];if(fileMap().has(key))playlist.push(key);musicCfg.sequence=[...playlist];saveMusicCfg();renderPlaylist();updateMiniMusicStatus()}
function togglePriority(key){const set=activePriority();set.has(key)?set.delete(key):set.add(key);musicCfg.priority=[...set];saveMusicCfg();renderPlaylist()}
function toggleRest(key){const set=activeRested();set.has(key)?set.delete(key):set.add(key);musicSession.rested=[...set];saveMusicSession();renderPlaylist();updateMiniMusicStatus()}
function setAssociation(key,situ){for(const [s,k] of Object.entries(musicCfg.associations||{}))if(k===key)delete musicCfg.associations[s];if(situ)musicCfg.associations[situ]=key;saveMusicCfg();renderPlaylist()}
function renderHistory(){const h=(musicSession?.history||[]).slice(-5).reverse();if($('scHistorySummary'))$('scHistorySummary').textContent=`Historial reciente (${h.length})`;if($('scHistory'))$('scHistory').innerHTML=h.length?h.map((k,i)=>`<div class="sc-history-row"><span>${escapeHtml(prettyTrack(k))}</span><small>${i===0?'última':`${i+1} atrás`}</small></div>`).join(''):'<div class="sc-sub">Todavía no hay historial.</div>'}
function renderPlaylist(){
  const host=$('scPlaylist');if(!host||!musicCfg||!musicSession)return;const situ=isSeasonalChannel()?situationKeys():[],played=activePlayed(),rested=activeRested(),priority=activePriority();
  if(!playlist.length)host.innerHTML='<div class="sc-sub">No hay canciones activas. Carga la carpeta o archivos para reconstruir la lista guardada.</div>';
  else host.innerHTML=playlist.map((k,i)=>{const assigned=Object.entries(musicCfg.associations||{}).find(([,v])=>v===k)?.[0]||'',current=currentPlaylistIndex===i&&activeDeck>=0,classes=['sc-song',current?'current':'',played.has(k)?'played':'',rested.has(k)?'resting':''].filter(Boolean).join(' '),badges=[priority.has(k)?'⭐ prioridad':'',rested.has(k)?'☾ descanso':played.has(k)?'✓ ya sonó':''].filter(Boolean).join(' · ');return `<div class="${classes}"><div class="sc-song-num">${String(i+1).padStart(2,'0')}</div><div><div class="sc-song-name">${current?'▶ ':''}${escapeHtml(prettyTrack(k))}</div><div class="sc-song-badges">${escapeHtml(badges)}</div></div><div class="sc-song-headtools"><button class="${priority.has(k)?'active':''}" data-priority-song="${encodeURIComponent(k)}" type="button" title="Prioridad en Aleatorio">${priority.has(k)?'★':'☆'}</button><button class="${rested.has(k)?'active':''}" data-rest-song="${encodeURIComponent(k)}" type="button" title="Descansar esta canción en esta sesión">${rested.has(k)?'☀':'☾'}</button></div><div class="sc-song-tools"><button class="btn-secondary" data-play-index="${i}" type="button" title="Reproducir">▶</button><button class="btn-secondary" data-up-index="${i}" type="button" ${i===0?'disabled':''} title="Subir">↑</button><button class="btn-secondary" data-down-index="${i}" type="button" ${i===playlist.length-1?'disabled':''} title="Bajar">↓</button><button class="btn-secondary" data-dup-index="${i}" type="button" title="Repetir este archivo justo después">＋</button><button class="btn-secondary" data-remove-index="${i}" type="button" title="Quitar esta aparición; si es la única, excluir canción">−</button></div>${isSeasonalChannel()?`<select data-assoc-song="${encodeURIComponent(k)}"><option value="">Sin situación asociada</option>${situ.map(s=>`<option value="${s}" ${assigned===s?'selected':''}>${escapeHtml(situationLabel(s))}</option>`).join('')}</select>`:''}</div>`}).join('');
  host.querySelectorAll('[data-play-index]').forEach(b=>b.onclick=()=>{markCurrentPlayedIfMeaningful();playTrackAt(Number(b.dataset.playIndex),true)});host.querySelectorAll('[data-up-index]').forEach(b=>b.onclick=()=>moveEntry(Number(b.dataset.upIndex),-1));host.querySelectorAll('[data-down-index]').forEach(b=>b.onclick=()=>moveEntry(Number(b.dataset.downIndex),1));host.querySelectorAll('[data-dup-index]').forEach(b=>b.onclick=()=>duplicateEntry(Number(b.dataset.dupIndex)));host.querySelectorAll('[data-remove-index]').forEach(b=>b.onclick=()=>removeEntry(Number(b.dataset.removeIndex)));host.querySelectorAll('[data-priority-song]').forEach(b=>b.onclick=()=>togglePriority(decodeURIComponent(b.dataset.prioritySong)));host.querySelectorAll('[data-rest-song]').forEach(b=>b.onclick=()=>toggleRest(decodeURIComponent(b.dataset.restSong)));host.querySelectorAll('[data-assoc-song]').forEach(sel=>sel.onchange=()=>setAssociation(decodeURIComponent(sel.dataset.assocSong),sel.value));
  const excluded=[...(musicCfg.excluded||[])];$('scExcludedSummary').textContent=`Canciones excluidas (${excluded.length})`;$('scExcluded').innerHTML=excluded.length?excluded.map(k=>`<div class="sc-excluded-row"><span>${escapeHtml(prettyTrack(k))}</span><button class="btn-secondary" data-restore-song="${encodeURIComponent(k)}" type="button">Restaurar</button></div>`).join(''):'<div class="sc-sub">Ninguna.</div>';$('scExcluded').querySelectorAll('[data-restore-song]').forEach(b=>b.onclick=()=>restoreExcluded(decodeURIComponent(b.dataset.restoreSong)));renderHistory();updateRoundStatus();
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
  refreshChannel();document.addEventListener('rv:session-changed',refreshChannel);document.addEventListener('rv:music-visibility-changed',refreshChannel);$('canalSelect')?.addEventListener('change',refreshChannel);
  document.addEventListener('hw:event',handleJackEvent);document.addEventListener('rv:sale-completed',handleNormalSaleCompleted);connectFirebase();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
