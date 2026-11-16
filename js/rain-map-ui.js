/* Interação da Operação Chuva centrada no mapa: nuvens, avisos e contornos municipais. */
(function(){
"use strict";
if(typeof map==="undefined"||typeof L==="undefined")return;
const el=id=>document.getElementById(id);
const normalize=x=>String(x||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
const htmlSafe=x=>String(x==null?"":x).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const finite=x=>x===null||x===undefined||x===""||!Number.isFinite(Number(x))?null:Number(x);
const fmt=x=>finite(x)===null?"—":finite(x).toLocaleString("pt-BR",{maximumFractionDigits:1})+" mm";
const pct=x=>finite(x)===null?"—":Math.round(finite(x))+"%";
const periods=[
  ["chuva_agora_mm","Chuva agora"],
  ["proximas_24h_mm","Próximas 24h"],
  ["proximas_48h_mm","Próximas 48h"],
  ["proximas_72h_mm","Próximas 72h"]
];
const allowed=window.__rainMapExtraAllowed=new WeakSet();
// Usar SVG em pane própria para que as divisões fiquem visíveis mesmo com Canvas no mapa.
const municipalPane=map.getPane("rainMunicipalPane")||map.createPane("rainMunicipalPane");
municipalPane.style.zIndex="475";
const municipalRenderer=L.svg({pane:"rainMunicipalPane",padding:0.3});
const layers={
  boundaries:L.layerGroup(),
  volumes:L.layerGroup(),
  clouds:L.layerGroup(),
  warningPolygons:L.layerGroup(),
  warnings:L.layerGroup()
};
let westPreviouslyVisible=false,westManaged=false;
for(const group of Object.values(layers))allowed.add(group);
// O renderer SVG também é um layer: impedir que o modo Florestal o remova.
allowed.add(municipalRenderer);
function allow(layer){allowed.add(layer);if(layer.eachLayer)layer.eachLayer(child=>allowed.add(child));return layer}
const state={mode:"fogo",clouds:false,inmet:false,metric:periods[0][0],rows:new Map(),alerts:[],alertOK:false,alertStale:false,forecastOK:false,forecastUpdated:null,alertUpdated:null,stale:false,loaded:false,selected:null,detailType:"chuva",loading:false,lastFetch:0,activeRainCount:0,currentFetchedAt:null};
const btnCloud=el("toggleRainClouds"),btnINMET=el("toggleRainINMET"),details=el("rainDetail");
const rainColors=["#c8ebf9","#84c5e5","#3c90c7","#225eac","#663fa8","#a631a2"];
function color(x){let n=finite(x);return n===null?"#64748b":n<1?rainColors[0]:n<10?rainColors[1]:n<25?rainColors[2]:n<50?rainColors[3]:n<100?rainColors[4]:rainColors[5]}
function isRain(){return document.body.dataset.mode==="chuva"}
function territory(){
  return typeof records==="undefined"?[]:records.filter(r=>isCoberturaOeste(r));
}
function fromCurrentMunicipality(name){return territory().find(r=>normalize(r.nome)===normalize(name))}
// Validação independente no navegador: um aviso futuro ou vencido nunca gera overlay.
function localBahiaNow(){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Bahia",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return p.year+"-"+p.month+"-"+p.day+"T"+p.hour+":"+p.minute;
}
function activeWarning(a){
  if(!a)return false;
  let inicio=String(a.inicio||"").slice(0,10);
  let fim=String(a.fim||"").slice(0,10);
  let horaI=String(a.hora_inicio||"").slice(0,5);
  let horaF=String(a.hora_fim||"").slice(0,5);
  if(!horaI||!horaF){
    const times=String(a.janela||"").match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+até\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/i);
    if(times){inicio=times[1];horaI=times[2];fim=times[3];horaF=times[4]}
  }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(inicio)||!/^\d{4}-\d{2}-\d{2}$/.test(fim)||!/^\d{2}:\d{2}$/.test(horaI)||!/^\d{2}:\d{2}$/.test(horaF))return false;
  const now=localBahiaNow();
  return inicio+"T"+horaI<=now&&now<=fim+"T"+horaF;
}
function alertsIn(name){
  return state.alertOK?state.alerts.filter(a=>activeWarning(a)&&Array.isArray(a.municipios)&&a.municipios.some(m=>normalize(m)===normalize(name))):[];
}
// Open-Meteo 'current.precipitation' reflete o período anterior (15 min modelados);
// a ausência do dado ou desatualização não é interpretada como chuva zero.
// Uma leitura válida de 0 mm indica ausência de precipitação modelada;
 // leitura ausente ou velha NÃO indica céu seco.
function currentReading(row){
  const amount=finite(row?.chuva_agora_mm);
  const at=Date.parse(String(row?.chuva_agora_horario_utc||""));
  const fileAt=Date.parse(String(state.currentFetchedAt||state.forecastUpdated||""));
  const now=Date.now();
  if(amount===null||!Number.isFinite(at)||!Number.isFinite(fileAt))return null;
  if(now-at>75*60000||now-at< -20*60000||now-fileAt>75*60000||now-fileAt< -20*60000)return null;
  return {amount,at,interval:finite(row?.chuva_agora_intervalo_segundos)};
}
function currentRain(row){
  const reading=currentReading(row);
  return reading&&reading.amount>0?reading.amount:null;
}
function cleanLink(u){return /^https:\/\/avisos\.inmet\.gov\.br\/[0-9]*$/.test(String(u||""))?u:"https://avisos.inmet.gov.br/"}
function readData(url){return fetch(url+"?v="+Date.now(),{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("HTTP "+r.status);return r.json()})}
// Fallback eventual: quando o GitHub Actions ainda não publicou a leitura nova,
// obter apenas as condições atuais em 5 lotes, sem confundi-las com dados observados.
async function fetchCurrentDirect(){
  try{
    const places=(await readData("dados/chuva/municipios.json")).municipios||[];
    const groups=[];for(let i=0;i<places.length;i+=12)groups.push(places.slice(i,i+12));
    const values=await Promise.allSettled(groups.map(async group=>{
      const params=new URLSearchParams({
        latitude:group.map(x=>x.lat).join(","),
        longitude:group.map(x=>x.lng).join(","),
        current:"precipitation,rain,showers",
        timeformat:"unixtime",timezone:"America/Bahia"
      });
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),14000);
      try{
        const resp=await fetch("https://api.open-meteo.com/v1/forecast?"+params.toString(),{signal:controller.signal});
        if(!resp.ok)throw Error("Open-Meteo "+resp.status);
        const body=await resp.json(),records=Array.isArray(body)?body:[body];
        if(records.length!==group.length)throw Error("Lote de chuva incompleto");
        return records.map((x,i)=>({nome:group[i].nome,current:x.current||{}}));
      }finally{clearTimeout(timer)}
    }));
    let updated=0;
    for(const result of values){
      if(result.status!=="fulfilled")continue;
      for(const r of result.value){
        const amount=finite(r.current.precipitation),at=r.current.time;
        if(amount===null||!Number.isFinite(Number(at)))continue;
        const name=normalize(r.nome),previous=state.rows.get(name)||{nome:r.nome};
        previous.chuva_agora_mm=amount;
        previous.chuva_agora_horario_utc=new Date(Number(at)*1000).toISOString();
        previous.chuva_agora_intervalo_segundos=r.current.interval||900;
        state.rows.set(name,previous);
        updated++;
      }
    }
    if(updated)state.currentFetchedAt=new Date().toISOString();
    else console.warn("Sem leitura de precipitação atual do Open-Meteo");
  }catch(e){console.warn("Fallback de chuva atual indisponível",e)}
}
function refreshRainMap(){
  updateMap();
  if(state.selected&&!details.hidden)showDetails(state.selected,state.detailType);
}
async function loadData(force=false){
  if(state.loading)return;
  if(state.loaded&&!force&&Date.now()-state.lastFetch<20*60*1000){refreshRainMap();return}
  state.loading=true;
  const [p,a]=await Promise.allSettled([
    readData("dados/chuva/previsao.json"),readData("dados/chuva/avisos.json")
  ]);
  if(p.status==="fulfilled"&&p.value.disponivel&&Array.isArray(p.value.municipios)&&p.value.municipios.length){
    state.rows=new Map(p.value.municipios.map(v=>[normalize(v.nome),v]));
    state.forecastUpdated=p.value.atualizado_em||null;
    state.currentFetchedAt=null;
    state.forecastOK=true;
    state.stale=!state.forecastUpdated||Date.now()-Date.parse(state.forecastUpdated)>5*3600000;
  }else{
    state.forecastOK=false;
    state.rows.clear();
    console.warn("Previsão de chuva do servidor indisponível: sem inferir ausência de chuva.");
  }
  if(a.status==="fulfilled"&&a.value.disponivel&&Array.isArray(a.value.avisos)){
    state.alerts=a.value.avisos;
    state.alertOK=true;
    state.alertUpdated=a.value.atualizado_em||null;
    const last=Date.parse(String(state.alertUpdated||""));
    state.alertStale=!Number.isFinite(last)||Date.now()-last>75*60000||Date.now()-last< -20*60000||a.value.consulta_ok===false;
  }else{
    state.alertOK=false;
    state.alertStale=true;
    state.alerts=[];
    console.warn("Avisos INMET indisponíveis: sem inferir ausência de avisos.");
  }
  // Quando o arquivo está antigo ou ainda não inclui current, consultar somente
  // o valor atual e manter as previsões de 24/48/72h do arquivo separadas.
  const freshCurrent=[...state.rows.values()].some(row=>{
    const date=Date.parse(String(row.chuva_agora_horario_utc||""));
    return finite(row.chuva_agora_mm)!==null&&Number.isFinite(date)&&Date.now()-date<60*60000&&Date.now()-date>= -20*60000;
  });
  if(!freshCurrent)await fetchCurrentDirect();
  state.loaded=true;state.lastFetch=Date.now();state.loading=false;refreshRainMap();
}
function setBaseBoundaries(rain){
  // No modo chuva, trocar a pintura vermelha pelo recorte municipal azul independente.
  if(rain){
    if(!westManaged){
      westPreviouslyVisible=map.hasLayer(westLayer);
      westManaged=true;
    }
    if(map.hasLayer(westLayer))map.removeLayer(westLayer);
  }else if(westManaged){
    if(westPreviouslyVisible&&!map.hasLayer(westLayer))map.addLayer(westLayer);
    westPreviouslyVisible=false;
    westManaged=false;
  }
}
function clearLayers(){
  for(const group of Object.values(layers)){
    if(map.hasLayer(group))map.removeLayer(group);
    group.clearLayers();
  }
}
function updateToolbar(){
  for(const [btn,on] of [[btnCloud,state.clouds],[btnINMET,state.inmet]]){
    if(!btn)continue;
    btn.classList.toggle("active",on);
    btn.setAttribute("aria-pressed",String(on));
  }
  const info=el("rainMapInfo");
  if(info){
    let text=state.forecastOK?state.rows.size+"/57 com previsão":"Previsão indisponível";
    const hasCurrent=[...state.rows.values()].some(row=>row&&Number.isFinite(Date.parse(String(row.chuva_agora_horario_utc||""))));
    if(state.clouds){
      if(!state.forecastOK||!hasCurrent)text+=" • chuva atual sem dados";
      else text+=" • "+state.activeRainCount+" município(s) com chuva indicada agora";
    }
    if(state.stale)text+=" • previsão desatualizada";
    const activeCount=state.alertOK?state.alerts.filter(activeWarning).length:null;
    text+=activeCount===null?" • INMET sem dados":state.alertStale?" • INMET: "+activeCount+" aviso(s) na última consulta — ATUALIZAÇÃO ATRASADA":" • "+activeCount+" aviso(s) INMET vigente(s)";
    info.textContent=text;
  }
}
function createCloud(rec,precipitation){
  // A nuvem representa SOMENTE precipitação atual modelada e recente no ponto amostrado.
  const label=htmlSafe(fmt(precipitation));
  const icon=L.divIcon({className:"rain-cloud-icon",html:'<div class="rain-cloud-bubble"><span>🌧️</span><b>'+label+'</b></div>',iconSize:[68,36],iconAnchor:[33,42]});
  const marker=L.marker([rec.center.lat,rec.center.lng],{icon,keyboard:true,riseOnHover:true,zIndexOffset:230,title:"Chuva atual (modelo): "+rec.nome});
  marker.bindTooltip(htmlSafe(rec.nome)+" · chuva indicada agora: "+label+" no período recente do modelo",{direction:"top",offset:[0,-30]});
  marker.on("click",()=>showDetails(rec.nome,"chuva"));
  return allow(marker);
}
function createInmet(rec,alerts){
  const extreme=alerts.some(a=>/grande perigo/i.test(a.severidade||""));
  const icon=L.divIcon({className:"rain-alert-icon",html:'<div class="rain-alert-bubble'+(extreme?' extreme':'')+'">⚠️'+(alerts.length>1?"<b>"+alerts.length+"</b>":"")+'</div>',iconSize:[36,34],iconAnchor:[-6,43]});
  const marker=L.marker([rec.center.lat,rec.center.lng],{icon,keyboard:true,riseOnHover:true,zIndexOffset:280,title:"Avisos INMET: "+rec.nome});
  marker.bindTooltip(htmlSafe(rec.nome)+" · "+alerts.length+" aviso(s)"+(state.alertStale?" (última consulta desatualizada)":""),{direction:"top",offset:[14,-24]});
  marker.on("click",()=>showDetails(rec.nome,"inmet"));
  return allow(marker);
}
function updateMap(){
  if(!isRain()||typeof mapReady==="undefined"||!mapReady)return;
  map.getContainer().classList.toggle("rain-cloud-compact",map.getZoom()<9);
  // O recorte da Base Sudoeste também é aplicado quando a malha termina de carregar.
  setBaseBoundaries(true);
  clearLayers();
  state.activeRainCount=0;
  for(const rec of territory()){
    // A borda do município continua visível quando Chuva e INMET estão desligados.
    const boundary=L.geoJSON(rec.feature,{
      renderer:municipalRenderer,
      interactive:true,
      bubblingMouseEvents:false,
      style:{color:"#3979a6",weight:2.25,opacity:1,fillColor:"#6d9abb",fillOpacity:0.09}
    });
    boundary.eachLayer(path=>{
      path.bindTooltip(htmlSafe(rec.nome),{sticky:true,direction:"top"});
      path.on("click",()=>showDetails(rec.nome,"chuva"));
      path.on("mouseover",()=>path.setStyle({color:"#1c597e",weight:3.1,fillOpacity:0.17}));
      path.on("mouseout",()=>path.setStyle({color:"#3979a6",weight:2.25,fillOpacity:0.09}));
    });
    layers.boundaries.addLayer(allow(boundary));
    if(state.clouds){
      const nowValue=currentRain(state.rows.get(normalize(rec.nome)));
      if(nowValue!==null){
        layers.clouds.addLayer(createCloud(rec,nowValue));
        state.activeRainCount++;
      }
    }
    if(state.inmet&&state.alertOK){
      const alerts=alertsIn(rec.nome);
      if(alerts.length){
        layers.warningPolygons.addLayer(allow(L.geoJSON(rec.feature,{interactive:false,style:{color:"#ff5353",weight:3.7,opacity:1,fillOpacity:0,dashArray:"6 3"}})));
        layers.warnings.addLayer(createInmet(rec,alerts));
      }
    }
  }
  if(state.inmet){
    allow(layers.warningPolygons).addTo(map);
  }
  // O contorno municipal fica acima das cores, sem bloquear os cliques nas nuvens.
  allow(layers.boundaries).addTo(map);
  if(state.clouds)allow(layers.clouds).addTo(map);
  if(state.inmet)allow(layers.warnings).addTo(map);
  updateToolbar();
}
function chart(series){
  const rows=(series||[]).slice(0,72);
  if(!rows.length)return '<p class="rain-muted">Sem série horária disponível.</p>';
  const max=Math.max(1,...rows.map(x=>finite(x[1])??0));
  const rectangles=rows.map((x,i)=>{
    const amount=finite(x[1])??0;
    const height=amount/max*56;
    return '<rect x="'+(8+i*5)+'" y="'+(65-height).toFixed(1)+'" width="3.8" height="'+height.toFixed(1)+'" rx="1" fill="#70c9ee"><title>'+htmlSafe(new Date(x[0]*1000).toLocaleString("pt-BR",{timeZone:"America/Bahia",day:"2-digit",hour:"2-digit"}))+' • '+htmlSafe(fmt(amount))+'</title></rect>';
  }).join("");
  return '<svg class="rain-bars" viewBox="0 0 380 85" role="img" aria-label="Precipitação horária prevista nas próximas 72 horas">'+rectangles+'<text x="8" y="80" fill="#bad9e9" font-size="9">Agora</text><text x="125" y="80" fill="#bad9e9" font-size="9">24h</text><text x="245" y="80" fill="#bad9e9" font-size="9">48h</text><text x="349" y="80" fill="#bad9e9" font-size="9">72h</text></svg>';
}
function showDetails(name,kind="chuva"){
  if(!isRain())return;
  state.selected=name;state.detailType=kind;
  const row=state.rows.get(normalize(name)),alerts=alertsIn(name);
  const reading=currentReading(row);
  const shown=state.metric==="chuva_agora_mm"?(reading?reading.amount:null):row?.[state.metric];
  let html='<div class="rain-detail-head"><strong>'+htmlSafe(name)+'</strong><button type="button" id="rainClose" class="rain-close" aria-label="Fechar informações">✕</button></div>';
  if(kind==="inmet")html+='<p class="rain-muted">Avisos meteorológicos oficiais do INMET neste município.</p>';
  if(state.alertOK&&state.alertStale){
    const at=state.alertUpdated?new Date(state.alertUpdated).toLocaleString("pt-BR",{timeZone:"America/Bahia",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):"não informado";
    html+='<p class="rain-muted"><strong>⚠️ INMET: última consulta desatualizada ('+htmlSafe(at)+').</strong> Os avisos podem ter mudado. <a href="https://avisos.inmet.gov.br/" rel="noopener" target="_blank">Conferir avisos oficiais</a>.</p>';
  }
  html+='<div class="rain-periods" role="group" aria-label="Selecionar período de chuva">'+periods.map(([key,label])=>
    '<button type="button" class="rain-period'+(state.metric===key?' selected':'')+'" data-map-period="'+htmlSafe(key)+'">'+htmlSafe(label)+'</button>').join("")+'</div>';
  const label=periods.find(x=>x[0]===state.metric)?.[1]||"Chuva agora";
  html+='<div class="rain-metric-hero"><b>'+htmlSafe(fmt(shown))+'</b><span>'+htmlSafe(label)+' • '+(state.metric==="chuva_agora_mm"?"Estimativa atual do Open-Meteo":"Previsão Open-Meteo")+'</span></div>';
  if(reading){
    const hora=new Date(reading.at).toLocaleString("pt-BR",{timeZone:"America/Bahia",hour:"2-digit",minute:"2-digit"});
    const minutos=reading.interval?Math.round(reading.interval/60):15;
    html+='<p class="rain-muted"><strong>Situação atual:</strong> '+(reading.amount>0?"Precipitação indicada":"Sem precipitação indicada")+' no ponto amostrado • '+htmlSafe(hora)+' • estimativa do período anterior (~'+minutos+' min).</p>';
  }else{
    html+='<p class="rain-muted"><strong>Chuva agora:</strong> dado indisponível ou desatualizado. Isso não significa ausência de chuva.</p>';
  }
  if(row){
    const cards=[["Chuva agora",fmt(reading?.amount)],["Próximas 48h",fmt(row.proximas_48h_mm)],["Próximas 72h",fmt(row.proximas_72h_mm)],["Últimas 24h • modelo",fmt(row.passadas_24h_estimativa_mm)],["Probabilidade máxima 24h",pct(row.probabilidade_max_24h_pct)],["Pico horário 72h",fmt(row.pico_horario_72h_mm)]];
    html+='<div class="rain-kpis">'+cards.map(x=>'<div class="rain-kpi"><strong>'+htmlSafe(x[1])+'</strong><small>'+htmlSafe(x[0])+'</small></div>').join("")+'</div>';
    html+='<div class="rain-muted">Precipitação por hora prevista</div>'+chart(row.serie_horaria);
    html+='<p class="rain-muted">Temperatura: '+htmlSafe(row.temperatura_c==null?"—":row.temperatura_c+" °C")+' • Umidade: '+htmlSafe(pct(row.umidade_pct))+' • Vento: '+htmlSafe(row.vento_kmh==null?"—":row.vento_kmh+" km/h")+'</p>';
  }else html+='<p class="rain-muted">Previsão indisponível. Isso não significa ausência de chuva.</p>';
  html+='<div class="rain-muted" style="font-weight:850;margin-top:11px">⚠️ Avisos do INMET</div>';
  if(!state.alertOK)html+='<p class="rain-muted">Consulta INMET indisponível. Verifique o site oficial.</p>';
  else if(!alerts.length)html+='<p class="rain-muted">Nenhum aviso identificado para este município na última consulta.</p>';
  else for(const a of alerts){
    html+='<div class="rain-alert-detail"><strong>'+htmlSafe(a.tipo)+' • '+htmlSafe(a.severidade)+'</strong>'+
      (a.janela?'<div><b>Validade:</b> '+htmlSafe(a.janela)+'</div>':"")+
      (a.riscos?'<div><b>Riscos:</b> '+htmlSafe(a.riscos).slice(0,1000)+'</div>':"")+
      (a.instrucoes?'<div><b>Orientações:</b> '+htmlSafe(a.instrucoes).slice(0,800)+'</div>':"")+
      '<a href="'+htmlSafe(cleanLink(a.url))+'" rel="noopener" target="_blank">Abrir aviso completo no INMET</a></div>';
  }
  html+='<p class="rain-muted">*As últimas 24h são estimadas por modelo meteorológico, não medições. Acumulado não representa classificação oficial de risco.</p>';
  details.innerHTML=html;
  details.hidden=false;
  el("rainClose").onclick=()=>{details.hidden=true;state.selected=null};
  details.querySelectorAll("[data-map-period]").forEach(btn=>btn.onclick=()=>{
    state.metric=btn.dataset.mapPeriod;
    updateMap();showDetails(name,kind);
  });
}
btnCloud.onclick=()=>{
  if(!isRain())return;
  state.clouds=!state.clouds;
  updateMap();
  if(state.clouds&&!state.forecastOK)loadData(true);
};
btnINMET.onclick=()=>{
  if(!isRain())return;
  state.inmet=!state.inmet;
  updateMap();
  if(state.inmet&&!state.alertOK)loadData(true);
};
function observeMode(){
  const next=isRain()?"chuva":"fogo";
  if(next===state.mode)return;
  state.mode=next;
  details.hidden=true;state.selected=null;
  if(next==="chuva"){
    setBaseBoundaries(true);
    updateMap();loadData();
  }else{
    clearLayers();setBaseBoundaries(false);
  }
  updateToolbar();
}
const watcher=new MutationObserver(observeMode);
watcher.observe(document.body,{attributes:true,attributeFilter:["data-mode"]});
setInterval(()=>{
  observeMode();
  if(!isRain())return;
  if(typeof mapReady!=="undefined"&&mapReady&&!map.hasLayer(layers.boundaries))updateMap();
  if(state.loaded&&Date.now()-state.lastFetch>5*60*1000)loadData(true);
  if(state.clouds||state.inmet)updateToolbar();
},1300);
map.on("zoomend",()=>map.getContainer().classList.toggle("rain-cloud-compact",map.getZoom()<9));
observeMode();
})();