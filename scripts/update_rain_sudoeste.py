#!/usr/bin/env python3
"""Atualiza chuva modelada Open-Meteo e alertas INMET. Não confundir chuva estimada com medida."""
import json, math, re, sys, unicodedata
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
import requests

ROOT = Path("dados/chuva")
LOCAIS = json.loads((ROOT/"municipios.json").read_text(encoding="utf-8"))["municipios"]
NOW = datetime.now(timezone.utc)
HOUR = int(NOW.timestamp()//3600*3600)
STAMP = NOW.isoformat(timespec="seconds").replace("+00:00", "Z")
session = requests.Session()
session.headers.update({"User-Agent":"MapaCBMBA-Sudoeste/1.0 (github.com/davissonednei/mapa-base-sudoeste-florestal)", "Accept":"application/json"})

def number(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None

def write(name, payload):
    (ROOT/name).write_text(json.dumps(payload, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")

def forecast():
    rows, errors = [], []
    for k in range(0, len(LOCAIS), 12):
        group = LOCAIS[k:k+12]
        params = {
            "latitude": ",".join(str(m["lat"]) for m in group),
            "longitude": ",".join(str(m["lng"]) for m in group),
            "hourly": "precipitation,precipitation_probability",
            "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,rain,showers",
            "past_days": 2, "forecast_days": 4,
            "timeformat": "unixtime", "timezone": "America/Bahia"
        }
        try:
            resp = session.get("https://api.open-meteo.com/v1/forecast",params=params,timeout=50)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data,dict): data=[data]
            if len(data)!=len(group): raise ValueError("Número incorreto de locais")
        except (requests.RequestException,ValueError) as exc:
            errors.append(str(exc)[:150]); continue
        for mun,data in zip(group,data):
            hourly = data.get("hourly") or {}
            times = hourly.get("time") or []
            mm = hourly.get("precipitation") or []
            pr = hourly.get("precipitation_probability") or []
            past, future = [], []
            for i,t in enumerate(times):
                if not isinstance(t,(int,float)): continue
                rain=number(mm[i]) if i<len(mm) else None
                prob=number(pr[i]) if i<len(pr) else None
                item=[int(t), round(rain,2) if rain is not None else None, round(prob) if prob is not None else None]
                if HOUR-86400 <= t < HOUR: past.append(item)
                if HOUR <= t < HOUR+72*3600: future.append(item)
            if len(future)<24:
                errors.append("Previsão insuficiente: "+mun["nome"]);continue
            def summation(hours):
                values=[i[1] for i in future if i[0]<HOUR+hours*3600]
                return round(sum(values),1) if len(values)>=hours and all(v is not None for v in values) else None
            earlier=[x[1] for x in past]
            probabilities=[x[2] for x in future[:24] if x[2] is not None]
            current=data.get("current") or {}
            rows.append({
                **mun,
                "passadas_24h_estimativa_mm":round(sum(earlier),1) if len(earlier)>=20 and all(v is not None for v in earlier) else None,
                "proximas_24h_mm":summation(24),"proximas_48h_mm":summation(48),"proximas_72h_mm":summation(72),
                "probabilidade_max_24h_pct":max(probabilities) if probabilities else None,
                "pico_horario_72h_mm":round(max((x[1] for x in future if x[1] is not None),default=0),1),
                "temperatura_c":number(current.get("temperature_2m")),
                "umidade_pct":number(current.get("relative_humidity_2m")),
                "vento_kmh":number(current.get("wind_speed_10m")),
                # Precipitação modelada no período imediatamente anterior ao horário 'current.time'.
                # No Brasil, o valor pode ser interpolado da previsão horária; NÃO é medição de estação.
                "chuva_agora_mm":number(current.get("precipitation")),
                "chuva_agora_horario_utc":(
                    datetime.fromtimestamp(int(current["time"]),timezone.utc).isoformat().replace("+00:00","Z")
                    if isinstance(current.get("time"),(int,float)) else None
                ),
                "chuva_agora_intervalo_segundos":current.get("interval"),
                "serie_horaria":future
            })
    write("previsao.json",{
        "atualizado_em":STAMP,"disponivel":bool(rows),"completo":len(rows)==len(LOCAIS),
        "municipios_esperados":len(LOCAIS),"municipios":rows,
        "fonte":"Open-Meteo","metodologia":"Precipitação modelada por ponto aproximado do município; chuva agora refere-se ao intervalo recente do modelo (aprox. 15 min), não é medição de pluviômetro; últimas 24h também são estimativa.","erros":errors
    })
    print("Previsões",len(rows),"/",len(LOCAIS))
    return bool(rows)

def normalize(s):
    text=unicodedata.normalize("NFD",str(s or "").lower())
    return "".join(x for x in text if unicodedata.category(x)!="Mn").strip()

def codes_names(value):
    codes,names=set(),set()
    def walk(x):
        if isinstance(x,(list,tuple)):
            for y in x:walk(y)
        elif isinstance(x,dict):
            for key in ("codigo_ibge","cod_ibge","geocode","geocodigo","codigo","id","nome","municipio"):
                if key in x:walk(x[key])
        elif x is not None:
            s=str(x)
            codes.update(re.findall(r"(?<!\d)29\d{5}(?!\d)",s))
            if len(s)<110 and not re.search(r"\d{5,}",s):names.add(normalize(s))
    walk(value)
    return codes,names

def aviso_vigente(inicio,fim,hora_inicio,hora_fim):
    """Incluir no mapa somente avisos dentro da janela de validade, em hora local BA."""
    if not inicio or not fim or not hora_inicio or not hora_fim:
        return False
    try:
        # Datas/horas exibidas pelo INMET são locais. Falta de campo -> não presumir vigência.
        ini=datetime.fromisoformat(str(inicio)[:10]+"T"+str(hora_inicio)[:5]+":00").replace(tzinfo=ZoneInfo("America/Bahia"))
        end=datetime.fromisoformat(str(fim)[:10]+"T"+str(hora_fim)[:5]+":00").replace(tzinfo=ZoneInfo("America/Bahia"))
        return ini<=NOW.astimezone(ZoneInfo("America/Bahia"))<=end
    except (ValueError,TypeError,OverflowError):
        return False

def warnings():
    try:
        r=session.get("https://apiprevmet3.inmet.gov.br/avisos/ativos",timeout=45)
        r.raise_for_status()
        payload=r.json()
        if isinstance(payload,dict): alerts=list(payload.get("hoje") or [])+list(payload.get("futuro") or [])
        elif isinstance(payload,list):alerts=payload
        else:raise ValueError("Formato não reconhecido")
        # A API pode repetir o mesmo aviso em "hoje" e "futuro".
        by_id={}
        for a in alerts:
            if not isinstance(a,dict): continue
            ident=str(a.get("id_aviso") or a.get("id") or a.get("codigo") or "")
            if ident not in by_id or (a.get("id_sequencia") or 0)>(by_id[ident].get("id_sequencia") or 0):
                by_id[ident]=a
        alerts=list(by_id.values())
        by_code={m["codigo_ibge"]:m["nome"] for m in LOCAIS}
        by_name={normalize(m["nome"]):m["nome"] for m in LOCAIS}
        result=[]
        for alert in alerts:
            if not isinstance(alert,dict):continue
            c,n=codes_names(alert.get("geocodes"))
            cc,nn=codes_names(alert.get("municipios"))
            c.update(cc);n.update(nn)
            matched={by_code[x] for x in c if x in by_code}
            matched.update(by_name[x] for x in n if x in by_name)
            if not matched:continue
            ident=str(alert.get("id_aviso") or alert.get("id") or alert.get("codigo") or "")
            inicio=str(alert.get("data_inicio") or alert.get("inicio") or "")[:10]
            fim=str(alert.get("data_fim") or alert.get("fim") or "")[:10]
            horas_i=str(alert.get("hora_inicio") or "")
            horas_f=str(alert.get("hora_fim") or "")
            if not aviso_vigente(inicio,fim,horas_i,horas_f):
                continue
            def descricao_limpa(value):
                return "\n".join(str(x).strip() for x in value if str(x).strip()) if isinstance(value,list) else str(value or "")
            result.append({
                "id":ident,
                "tipo":str(alert.get("descricao") or alert.get("tipo") or alert.get("evento") or "Aviso meteorológico"),
                "severidade":str(alert.get("severidade") or alert.get("nivel") or "Não informada"),
                "inicio":inicio,"fim":fim,"hora_inicio":horas_i,"hora_fim":horas_f,
                "janela":inicio+" "+horas_i+" até "+fim+" "+horas_f,
                "descricao":str(alert.get("descricao") or ""),
                "riscos":descricao_limpa(alert.get("riscos")),
                "instrucoes":descricao_limpa(alert.get("instrucoes")),"municipios":sorted(matched),
                "url":"https://avisos.inmet.gov.br/"+ident if ident.isdigit() else "https://avisos.inmet.gov.br/"
            })
        write("avisos.json",{"atualizado_em":STAMP,"disponivel":True,"avisos":result,"fonte":"INMET (apenas avisos vigentes no instante da consulta)"})
        print("Avisos VIGENTES na área:",len(result))
    except (requests.RequestException,ValueError,TypeError) as exc:
        write("avisos.json",{"atualizado_em":STAMP,"disponivel":False,"avisos":[],"fonte":"INMET","erro":str(exc)[:160]})
        print("INMET indisponível; NÃO equivale a ausência de avisos",file=sys.stderr)

if __name__=="__main__":
    ok=forecast()
    warnings()
    if not ok:sys.exit("Falha no acesso à previsão")
