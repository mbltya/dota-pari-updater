import {pathToFileURL} from 'node:url';
export const LEAGUE=20395,STOP=Date.parse('2026-11-05T00:00:00Z');
const HOST='https://dota-team-tracker-private.dota-team-tracker.workers.dev';
const needs=m=>!m?.draftComplete||m.radiantKills==null||m.direKills==null||m.players?.length!==10||m.players.some(p=>!p.name||p.name==='Игрок неизвестен');
export function project(raw){
 const keys=['match_id','leagueid','start_time','duration','radiant_win','radiant_team_id','dire_team_id','radiant_score','dire_score','series_id','patch'];
 const d=Object.fromEntries(keys.filter(k=>raw[k]!=null).map(k=>[k,raw[k]]));
 if(raw.players)d.players=raw.players.map(p=>Object.fromEntries(['account_id','hero_id','player_slot','name','personaname'].filter(k=>p[k]!=null).map(k=>[k,p[k]])));
 if(raw.picks_bans)d.picks_bans=raw.picks_bans.map(p=>({hero_id:p.hero_id,team:p.team,is_pick:p.is_pick,order:p.order}));return d;
}
export async function boundedJSON(url,options={},fetcher=fetch,at=Date.now()){
 let r;const readOnly=!options.method||options.method==='GET';
 for(let attempt=0;attempt<(readOnly?3:1);attempt++){
  try{r=await fetcher(url,{...options,signal:AbortSignal.timeout(20000)});break;}
  catch(error){if(readOnly&&attempt<2){await new Promise(resolve=>setTimeout(resolve,250*(2**attempt)));continue;}const raw=error?.cause?.code??error?.code??'NETWORK',code=/^[A-Z_0-9]{1,64}$/.test(raw)?raw:'NETWORK';throw Error(new URL(url).hostname+' '+(options.method??'GET')+': ошибка соединения ('+code+')');}
 }
 if(!r.ok){const e=Error('HTTP '+r.status);e.httpStatus=r.status;const retry=r.headers.get('retry-after'),after=/^\d+$/.test(retry??'')?at+Number(retry)*1000:Date.parse(retry??'');let time=Math.max(at+300000,Number.isFinite(after)?after:0);const remaining=r.headers.get('x-rate-limit-remaining-day');if(remaining!=null&&/^-?\d+$/.test(remaining)&&Number(remaining)<=0)time=Math.max(time,Date.parse(new Date(at).toISOString().slice(0,10)+'T00:00:00Z')+86400000);if([429,503].includes(r.status))e.retryAt=new Date(Math.min(time,at+7*86400000)).toISOString();await r.body?.cancel();throw e;}
 const reader=r.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024)throw Error('Ответ превышает 4 MiB');chunks.push(value);}}catch(e){await reader.cancel();throw e;}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
export async function collect({token=process.env.PARI_INGEST_TOKEN,site=process.env.PARI_SITE_URL??HOST,fetcher=fetch,at=Date.now(),wait=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>Date.now()}={}){
 if(at>=STOP)return {stopped:true};if(!token||token.length<40)throw Error('Не настроен PARI_INGEST_TOKEN');
 if(site.replace(/\/$/,'')!==HOST)throw Error('Неверный адрес приёмника');
 const endpoint=HOST+'/api/pari/automation',headers={Authorization:'Bearer '+token,Accept:'application/json','Content-Type':'application/json'},current=await boundedJSON(endpoint,{headers},fetcher,at);
 if(current.snapshot?.leagueId!==LEAGUE||!Array.isArray(current.snapshot.maps))throw Error('Неверный снимок Cloudflare');
 if(Date.parse(current.status?.nextRetryAt??'')>at)return {backoff:true,retryAt:current.status.nextRetryAt};
 const payload={schemaVersion:1,leagueId:LEAGUE,startedAt:new Date(at).toISOString(),rows:[],details:[],attempted:[]};
 const failure=e=>({httpStatus:[429,503,502,504,408,500].includes(e.httpStatus)?e.httpStatus:0,...(e.retryAt?{retryAt:e.retryAt}:{})});
 try{
  const rows=await boundedJSON('https://api.opendota.com/api/leagues/'+LEAGUE+'/matches',{headers:{Accept:'application/json','User-Agent':'DotaPariUpdater/1.0'}},fetcher,at);
  if(!Array.isArray(rows)||rows.length>512||rows.some(r=>!Number.isSafeInteger(r.match_id)||r.match_id<=0||r.leagueid!==LEAGUE)||(!rows.length&&current.snapshot.maps.length))throw Error('Некорректный список OpenDota');
  payload.rows=[...new Map(rows.map(r=>[r.match_id,project(r)])).values()];
  const maps=new Map(current.snapshot.maps.map(m=>[m.id,m])),attempts=current.attempts??{},pending=payload.rows.filter(r=>needs(maps.get(r.match_id)));
  const queue=(pending.length?pending:payload.rows.filter(r=>at-(attempts[r.match_id]??0)>=6*3600000)).sort((a,b)=>Number(maps.has(a.match_id))-Number(maps.has(b.match_id))||(attempts[a.match_id]??0)-(attempts[b.match_id]??0)||b.start_time-a.start_time).slice(0,5);
  for(const row of queue){await wait(1250);payload.attempted.push(row.match_id);try{const detail=await boundedJSON('https://api.opendota.com/api/matches/'+row.match_id,{headers:{Accept:'application/json','User-Agent':'DotaPariUpdater/1.0'}},fetcher,at);if(detail.match_id!==row.match_id||detail.leagueid!==LEAGUE)throw Error('Чужая карта');payload.details.push(project(detail));}catch(e){payload.detailFailure=failure(e);if([429,503].includes(e.httpStatus))break;}}
 }catch(e){payload.failure=failure(e);delete payload.rows;delete payload.details;delete payload.attempted;}
 payload.checkedAt=new Date(now()).toISOString();
 const result=await boundedJSON(endpoint,{method:'POST',headers,body:JSON.stringify(payload)},fetcher,at);
 if(!result.ok)throw Error('Cloudflare не подтвердила сохранение');
 if(payload.failure||payload.detailFailure)throw Error('OpenDota временно недоступна. Статус передан в Cloudflare, прежние подробности сохранены.');return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(JSON.stringify(await collect()));}catch(e){console.error(e.message);process.exitCode=1;}}
