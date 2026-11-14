/* Modo Chuva • Base Sudoeste / 7º BBM. Dados de previsão são modelados. */
(function(){
  "use strict";
  if(typeof L==="undefined"||typeof map==="undefined")return;
  const rainLayer=L.layerGroup(),warningLayer=L.layerGroup(),rainElements=new Set(),hiddenFire=new Set();
  const s={mode:"fogo",metric:"proximas_24h_mm",rows:new Map(),alerts:[],alertsOK:false,forecastAt:null,alertAt:null,stale:false,loading:false,rainOn:true,alertOn:true,selected:null};
  const $=id=>document.getElementById(id);
  const norm=x=>String(x||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
  const esc=x=>String(x==null?"":x).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const num=x=>x===null||x===undefined||x===""||!Number.isFinite(Number(x))?null:Number(x);
  const mm=x=>num(x)===null?"—":num(x).toLocaleString("pt-BR",{maximumFractionDigits:1})+" mm";
  const pct=x=>num(x)===null?"—":Math.round(num(x))+"%";
  const fresh=t=>t&&Number.isFinite(Date.parse(t))&&(Date.now()-Date.parse(t))>=0&&(Date.now()-Date.parse(t))<4.5*3600000;
  const colors=["#c8ebf9","#84c5e5","#3c90c7","#225eac","#663fa8","#a631a2"];
  const color=x=>num(x)===null?"#64748b":x<1?colors[0]:x<10?colors[1]:x<25?colors[2]:x<50?colors[3]:x<100?colors[4]:colors[5];
  const put=(id,value)=>{const el=$(id);if(el)el.textContent=value};
  const active=()=>s.mode==="chuva";
  const tagF=$("modeFire"),tagR=$("modeRain"),panel=$("rainAside"),detail=$("rainDetail");
  const logo=document.querySelector(".brand .logo"),sub=document.querySelector(".brand .sub"),originalSub=sub?.textContent;

  function permitted(layer){
    if([streetLayer,satelliteLayer,westLayer,contextLayer,baseLayer,guarnicaoLayer,rainLayer,warningLayer].includes(layer)||rainElements.has(layer))return true;
    return [westLayer,contextLayer,baseLayer,guarnicaoLayer,rainLayer,warningLayer].some(g=>g.hasLayer(layer));
  }
  map.on("layeradd",e=>{
    if(!active()||permitted(e.layer))return;
    hiddenFire.add(e.layer);
    map.removeLayer(e.layer);
  });
  function switchMode(next){
    if(next===s.mode)return;
    s.mode=next;
    const rain=active();
    document.body.dataset.mode=next;panel.hidden=!rain;$("rainMapLegend").hidden=!rain;detail.hidden=true;s.selected=null;
    tagF.classList.toggle("active",!rain);tagR.classList.toggle("active",rain);
    tagF.setAttribute("aria-pressed",String(!rain));tagR.setAttribute("aria-pressed",String(rain));
    if(logo)logo.textContent=rain?"🌧️":"🔥";
    if(sub)sub.textContent=rain?"Operação Chuva • 7º BBM • Open-Meteo / INMET":originalSub;
    map.closePopup();
    if(rain){
      map.eachLayer(l=>{if(!permitted(l)){hiddenFire.add(l);map.removeLayer(l)}});
      if(s.rainOn)rainLayer.addTo(map);
      if(s.alertOn)warningLayer.addTo(map);
      load();
      if(typeof westBounds!=="undefined"&&westBounds)map.fitBounds(westBounds,{padding:[18,18]});
    }else{
      map.removeLayer(rainLayer);map.removeLayer(warningLayer);
      for(const layer of hiddenFire){try{if(!map.hasLayer(layer))map.addLayer(layer)}catch(e){console.warn(e)}}
      hiddenFire.clear();
    }
    setTimeout(()=>map.invalidateSize(),100);
  }
  tagF.onclick=()=>switchMode("fogo");tagR.onclick=()=>switchMode("chuva");

  async function get(url,sec=25){
    const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),sec*1000);
    try{const r=await fetch(url,{cache:"no-store",signal:ac.signal});if(!r.ok)throw Error("HTTP "+r.status);return await r.json()}
    finally{clearTimeout(timer)}
  }
  function process(m,d,h){
    const hourly=d.hourly||{},t=hourly.time||[],amount=hourly.precipitation||[],chance=hourly.precipitation_probability||[];
    const past=[],future=[];
    t.forEach((time,i)=>{const value=[time,num(amount[i]),num(chance[i])];if(time>=h-86400&&time<h)past.push(value);if(time>=h&&time<h+259200)future.push(value)});
    const sum=hours=>{const arr=future.filter(v=>v[0]<h+hours*3600).map(v=>v[1]);return arr.length>=hours&&arr.every(v=>v!==null)?Math.round(arr.reduce((a,b)=>a+b,0)*10)/10:null};
    const before=past.map(v=>v[1]),prob=future.slice(0,24).map(v=>v[2]).filter(v=>v!==null);
    return Object.assign({},m,{proximas_24h_mm:sum(24),proximas_48h_mm:sum(48),proximas_72h_mm:sum(72),
      passadas_24h_estimativa_mm:before.length>=20&&before.every(v=>v!==null)?Math.round(before.reduce((a,b)=>a+b,0)*10)/10:null,
      probabilidade_max_24h_pct:prob.length?Math.max(...prob):null,
      pico_horario_72h_mm:Math.max(0,...future.map(v=>v[1]).filter(v=>v!==null)),
      temperatura_c:num(d.current?.temperature_2m),umidade_pct:num(d.current?.relative_humidity_2m),
      vento_kmh:num(d.current?.wind_speed_10m),serie_horaria:future});
  }
  async function forecastDirect(){
    const places=(await get("dados/chuva/municipios.json?v="+Date.now())).municipios||[];
    const batches=[];for(let i=0;i<places.length;i+=12)batches.push(places.slice(i,i+12));
    const hour=Math.floor(Date.now()/3600000)*3600;
    const results=await Promise.allSettled(batches.map(async part=>{
      const args=new URLSearchParams({latitude:part.map(x=>x.lat).join(","),longitude:part.map(x=>x.lng).join(","),
        hourly:"precipitation,precipitation_probability",current:"temperature_2m,relative_humidity_2m,wind_speed_10m",
        past_days:"2",forecast_days:"4",timeformat:"unixtime",timezone:"America/Bahia"});
      const raw=await get("https://api.open-meteo.com/v1/forecast?"+args,35),set=Array.isArray(raw)?raw:[raw];
      if(set.length!==part.length)throw Error("Quantidade de locais inválida");
      return set.map((r,i)=>process(part[i],r,hour));
    }));
    const rows=results.filter(x=>x.status==="fulfilled").flatMap(x=>x.value);
    if(!rows.length)throw Error("Previsão indisponível");
    return {atualizado_em:new Date().toISOString(),disponivel:true,municipios:rows};
  }
  function receive(data,stale){
    s.rows.clear();(data.municipios||[]).forEach(row=>{if(row?.nome)s.rows.set(norm(row.nome),row)});
    s.forecastAt=data.atualizado_em;s.stale=stale;render();
  }
  async function loadForecast(){
    let cached=null;try{cached=await get("dados/chuva/previsao.json?v="+Date.now(),12)}catch(e){}
    if(cached?.disponivel&&cached.municipios?.length&&fresh(cached.atualizado_em)){receive(cached,false);return}
    try{receive(await forecastDirect(),false)}
    catch(e){if(cached?.disponivel&&cached.municipios?.length)receive(cached,true);else put("rainStatus","Previsão indisponível");console.warn("Open-Meteo",e)}
  }
  function parseAlerts(obj,places){
    const alerts=Array.isArray(obj)?obj:Array.isArray(obj?.avisos)?obj.avisos:[...(obj?.hoje||[]),...(obj?.futuro||[])];
    const codeMap=new Map(places.map(m=>[String(m.codigo_ibge),m.nome])),names=new Map(places.map(m=>[norm(m.nome),m.nome]));
    const parsed=alerts.flatMap(a=>{
      if(!a||typeof a!=="object")return [];
      const mentions=JSON.stringify([a.geocodes,a.municipios,a.municipios_afetados]),matched=new Set();
      for(const id of mentions.match(/29\d{5}/g)||[])if(codeMap.has(id))matched.add(codeMap.get(id));
      for(const x of a.municipios||[]){
        const name=typeof x==="string"?x:x?.nome||x?.municipio;
        if(names.has(norm(name)))matched.add(names.get(norm(name)));
      }
      if(!matched.size)return [];
      const id=String(a.id_aviso||a.id||a.codigo||"");
      const inicio=a.inicio||a.data_inicio||"",fim=a.fim||a.data_fim||"";
      return [{id,tipo:String(a.tipo||a.descricao||a.evento||a.nome||"Aviso meteorológico"),severidade:String(a.severidade||a.nivel||"Não informada"),inicio,fim,
        janela:String(a.janela||(String(inicio).slice(0,10)+" "+String(a.hora_inicio||"")+" até "+String(fim).slice(0,10)+" "+String(a.hora_fim||""))),
        descricao:String(a.descricao||""),riscos:Array.isArray(a.riscos)?a.riscos.join(" "):String(a.riscos||""),
        instrucoes:Array.isArray(a.instrucoes)?a.instrucoes.join(" "):String(a.instrucoes||""),
        municipios:[...matched],url:/^\d+$/.test(id)?"https://avisos.inmet.gov.br/"+id:"https://avisos.inmet.gov.br/"}];
    });
    return [...new Map(parsed.map(a=>[a.id||a.tipo+"|"+a.janela,a])).values()];
  }
  async function loadAlerts(){
    let old=null,places=[];
    try{old=await get("dados/chuva/avisos.json?v="+Date.now(),12)}catch(e){}
    try{places=(await get("dados/chuva/municipios.json?v="+Date.now(),12)).municipios||[]}catch(e){}
    if(old?.disponivel&&fresh(old.atualizado_em)){
      s.alerts=parseAlerts(old,places);s.alertsOK=true;s.alertAt=old.atualizado_em;render();return;
    }
    try{const raw=await get("https://apiprevmet3.inmet.gov.br/avisos/ativos",15);s.alerts=parseAlerts(raw,places);s.alertsOK=true;s.alertAt=new Date().toISOString()}
    catch(e){s.alerts=[];s.alertsOK=false;s.alertAt=null;console.warn("Avisos INMET indisponíveis: não significa ausência de avisos",e)}
    render();
  }
  async function load(){
    if(s.loading)return;
    if(s.rows.size&&fresh(s.forecastAt)&&s.alertsOK&&fresh(s.alertAt)){render();return}
    s.loading=true;put("rainStatus","Consultando previsão e avisos…");
    try{await Promise.allSettled([loadForecast(),loadAlerts()])}finally{s.loading=false}
  }
  function warningsFor(name){return s.alertsOK?s.alerts.filter(a=>a.municipios.some(n=>norm(n)===norm(name))):[]}
  function updateStats(){
    const values=[...s.rows.values()].map(r=>num(r[s.metric])).filter(x=>x!==null);
    put("rainMax",values.length?mm(Math.max(...values)):"—");
    put("rainTwenty",values.length?String(values.filter(x=>x>=20).length):"—");
    put("rainCover",s.rows.size+"/57");put("rainAlertCount",s.alertsOK?String(s.alerts.length):"—");
    put("rainMaxLabel",s.metric.startsWith("passadas")?"MAIOR ESTIMATIVA PASSADA · 24H":"MAIOR ACUMULADO PREVISTO");
    put("rainStatus",s.rows.size?(s.stale?"Previsão desatualizada":s.rows.size===57?"Previsão disponível":"Cobertura parcial"):"Previsão indisponível");
    put("rainUpdate",s.forecastAt?new Date(s.forecastAt).toLocaleString("pt-BR",{timeZone:"America/Bahia",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})+" • Open-Meteo":"Fonte: Open-Meteo");
  }
  function ranking(){
    if(typeof records==="undefined")return;
    const target=$("rainCities"),q=norm($("rainSearch").value);
    const items=records.filter(r=>isCoberturaOeste(r)&&(!q||norm(r.nome).includes(q)));
    items.sort((a,b)=>(num(s.rows.get(norm(b.nome))?.[s.metric])??-1)-(num(s.rows.get(norm(a.nome))?.[s.metric])??-1)||a.nome.localeCompare(b.nome,"pt-BR"));
    target.replaceChildren();
    for(const r of items){
      const btn=document.createElement("button"),name=document.createElement("b"),sub=document.createElement("small"),left=document.createElement("span"),val=document.createElement("em");
      btn.className="rain-city";btn.type="button";name.textContent=r.nome;
      sub.textContent=warningsFor(r.nome).length?"⚠️ Aviso INMET":s.rows.has(norm(r.nome))?"Previsão modelada":"Sem dados";
      val.textContent=mm(s.rows.get(norm(r.nome))?.[s.metric]);left.append(name,sub);btn.append(left,val);
      btn.onclick=()=>{const layer=featureLayers[norm(r.nome)];if(layer)map.fitBounds(layer.getBounds(),{padding:[35,35],maxZoom:9});showCity(r.nome)};
      target.appendChild(btn);
    }
  }
  function chart(hours){
    const rows=(hours||[]).slice(0,72);if(!rows.length)return '<p class="rain-muted">Série horária indisponível.</p>';
    const max=Math.max(1,...rows.map(x=>num(x[1])??0));
    const bars=rows.map((r,i)=>{
      const n=num(r[1])??0,h=n/max*53;
      return '<rect x="'+(8+i*5)+'" y="'+(62-h).toFixed(1)+'" width="3.7" height="'+h.toFixed(1)+'" fill="#64c1eb"><title>'+esc(new Date(r[0]*1000).toLocaleString("pt-BR",{timeZone:"America/Bahia",hour:"2-digit",day:"2-digit"}))+" • "+esc(mm(n))+'</title></rect>';
    }).join("");
    return '<svg class="rain-bars" viewBox="0 0 380 83" role="img" aria-label="Precipitação horária prevista">'+bars+'<text x="8" y="77" fill="#b7d3e7" font-size="9">Agora</text><text x="126" y="77" fill="#b7d3e7" font-size="9">24h</text><text x="245" y="77" fill="#b7d3e7" font-size="9">48h</text><text x="350" y="77" fill="#b7d3e7" font-size="9">72h</text></svg>';
  }
  function showCity(name){
    if(!active())return;s.selected=name;
    const r=s.rows.get(norm(name)),alerts=warningsFor(name);
    let h='<div class="rain-detail-head"><strong>'+esc(name)+'</strong><button class="rain-close" id="rainClose">✕</button></div>';
    if(r){
      const info=[["Previsão 24h",mm(r.proximas_24h_mm)],["Previsão 48h",mm(r.proximas_48h_mm)],["Previsão 72h",mm(r.proximas_72h_mm)],["Passadas 24h · modelo",mm(r.passadas_24h_estimativa_mm)],["Probabilidade máxima",pct(r.probabilidade_max_24h_pct)],["Pico horário 72h",mm(r.pico_horario_72h_mm)]];
      h+='<div class="rain-kpis">'+info.map(x=>'<div class="rain-kpi"><strong>'+esc(x[1])+'</strong><small>'+esc(x[0])+'</small></div>').join("")+'</div><div class="rain-muted">Distribuição horária prevista</div>'+chart(r.serie_horaria);
      h+='<p class="rain-muted">Temperatura '+esc(r.temperatura_c==null?"—":r.temperatura_c+" °C")+' • Umidade '+esc(pct(r.umidade_pct))+' • Vento '+esc(r.vento_kmh==null?"—":r.vento_kmh+" km/h")+'</p>';
    }else h+='<p class="rain-muted">Previsão indisponível para este município.</p>';
    h+='<p class="rain-muted">'+(s.alertsOK?(alerts.length?alerts.map(a=>"⚠️ "+esc(a.tipo)+" ("+esc(a.severidade)+")").join("<br>"):"Sem aviso identificado no último retorno do INMET."):"Consulta INMET indisponível.")+'</p>';
    h+='<p class="rain-muted">Dados modelados não são medições nem alertas oficiais de risco.</p>';
    detail.innerHTML=h;detail.hidden=false;$("rainClose").onclick=()=>{detail.hidden=true;s.selected=null};
  }
  function renderMap(){
    if(!active()||!s.rows.size||typeof mapReady==="undefined"||!mapReady)return;
    rainLayer.clearLayers();warningLayer.clearLayers();rainElements.clear();
    for(const rec of records.filter(x=>isCoberturaOeste(x))){
      const amount=num(s.rows.get(norm(rec.nome))?.[s.metric]);
      const shape=L.geoJSON(rec.feature,{style:{color:"#49728b",weight:1.1,fillColor:color(amount),fillOpacity:amount===null?0.08:0.62}});
      shape.eachLayer(l=>{rainElements.add(l);l.bindTooltip(esc(rec.nome)+" • "+esc(mm(amount)),{sticky:true});l.on("click",()=>showCity(rec.nome))});
      rainElements.add(shape);rainLayer.addLayer(shape);
      if(s.alertsOK&&warningsFor(rec.nome).length){
        const outline=L.geoJSON(rec.feature,{interactive:false,style:{color:"#ff4040",weight:3.5,fillOpacity:0,dashArray:"6 3"}});
        outline.eachLayer(l=>rainElements.add(l));rainElements.add(outline);warningLayer.addLayer(outline);
      }
    }
    if(s.rainOn&&!map.hasLayer(rainLayer))rainLayer.addTo(map);
    if(s.alertOn&&!map.hasLayer(warningLayer))warningLayer.addTo(map);
  }
  function renderAlerts(){
    const n=$("rainWarnings");
    if(!s.alertsOK){n.innerHTML='<p class="rain-muted">INMET indisponível. Não interpretar como ausência de avisos. <a href="https://avisos.inmet.gov.br/" target="_blank" rel="noopener">Consultar avisos oficiais</a>.</p>';return}
    if(!s.alerts.length){n.innerHTML='<p class="rain-muted">Nenhum aviso identificado para os 57 municípios na última consulta ao INMET.</p>';return}
    n.innerHTML=s.alerts.map(a=>{
      const link=/^https:\/\/avisos\.inmet\.gov\.br\/[\w/-]*$/.test(a.url)?a.url:"https://avisos.inmet.gov.br/";
      return '<div class="rain-alert"><strong>⚠️ '+esc(a.tipo)+" • "+esc(a.severidade)+'</strong><div>'+esc(a.municipios.join(", "))+'</div>'+
        (a.janela?'<p><b>Validade:</b> '+esc(a.janela)+'</p>':"")+
        (a.riscos?'<p><b>Riscos:</b> '+esc(a.riscos).slice(0,900)+'</p>':"")+
        (a.instrucoes?'<p><b>Orientações:</b> '+esc(a.instrucoes).slice(0,900)+'</p>':"")+
        '<p><a href="'+esc(link)+'" rel="noopener" target="_blank">Aviso completo</a></p></div>';
    }).join("");
  }
  function render(){
    if(!active())return;
    updateStats();ranking();renderAlerts();renderMap();
    if(s.selected)showCity(s.selected);
  }
  document.querySelectorAll("[data-rain]").forEach(btn=>btn.onclick=()=>{
    s.metric=btn.dataset.rain;
    document.querySelectorAll("[data-rain]").forEach(x=>x.classList.toggle("active",x===btn));
    render();
  });
  $("rainSearch").oninput=ranking;
  $("rainToggleVolume").onclick=function(){s.rainOn=!s.rainOn;this.classList.toggle("off",!s.rainOn);if(s.rainOn)rainLayer.addTo(map);else map.removeLayer(rainLayer)};
  $("rainToggleAlert").onclick=function(){s.alertOn=!s.alertOn;this.classList.toggle("off",!s.alertOn);if(s.alertOn)warningLayer.addTo(map);else map.removeLayer(warningLayer)};
  // Exibe o mapa de chuva assim que a malha de 57 municípios terminar de carregar.
  setInterval(()=>{
    if(active()&&s.rows.size&&typeof mapReady!=="undefined"&&mapReady&&!rainLayer.getLayers().length)render();
  },750);
  setInterval(()=>{
    if(!active())return;
    if(s.rows.size&&typeof mapReady!=="undefined"&&mapReady&&!rainLayer.getLayers().length)render();
    if(!s.loading&&(!fresh(s.forecastAt)||!fresh(s.alertAt)))load();
  },20*60*1000);
  window.operacaoSudoeste={getMode:()=>s.mode,setMode:switchMode,atualizarChuva:load};
})();
