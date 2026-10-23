import test from 'node:test';
import assert from 'node:assert/strict';
import {collect,boundedJSON,STOP} from './run.mjs';
const at=Date.parse('2026-10-23T12:00:00Z'),token='test-only-'.repeat(6),cloud='https://dota-team-tracker-private.dota-team-tracker.workers.dev/api/pari/automation';
const raw=id=>({match_id:id,leagueid:20395,start_time:at/1000,duration:2400,radiant_win:true,radiant_team_id:7119388,dire_team_id:10291652});
test('новые карты передаются ограниченным пакетом, токен только для своего приёмника',async()=>{
 let payload,details=0;const fetcher=async(url,options={})=>{if(url===cloud){assert.equal(options.headers.Authorization,'Bearer '+token);if(options.method==='POST'){payload=JSON.parse(options.body);return Response.json({ok:true,maps:6});}return Response.json({snapshot:{leagueId:20395,maps:[]}});}assert.equal(options.headers.Authorization,undefined);if(url.includes('/leagues/'))return Response.json(Array.from({length:6},(_,i)=>raw(i+1)));details++;return Response.json(raw(Number(url.split('/').at(-1))));};
 await collect({token,fetcher,at,now:()=>at,wait:async()=>{}});assert.equal(details,5);assert.equal(payload.details.length,5);assert.equal(payload.rows.length,6);assert.equal(payload.attempted.length,5);
});
test('429 сохраняет статус и соблюдает Retry-After, не скачивает подробности',async()=>{
 let payload,calls=0;const fetcher=async(url,options={})=>{if(url===cloud){if(options.method==='POST'){payload=JSON.parse(options.body);return Response.json({ok:true});}return Response.json({snapshot:{leagueId:20395,maps:[]}});}calls++;return new Response('',{status:429,headers:{'Retry-After':'3600'}});};
 await assert.rejects(collect({token,fetcher,at,now:()=>at}),/временно недоступна/);assert.equal(calls,1);assert.equal(payload.failure.httpStatus,429);assert.equal(Date.parse(payload.failure.retryAt),at+3600000);
 let reads=0;const backoff=await collect({token,at,fetcher:async()=>{reads++;return Response.json({snapshot:{leagueId:20395,maps:[]},status:{nextRetryAt:payload.failure.retryAt}});}});assert.equal(backoff.backoff,true);assert.equal(reads,1);
});
test('отрицательный остаток суточной квоты ждёт следующего UTC дня',async()=>{
 await assert.rejects(boundedJSON('https://example.test',{},async()=>new Response('',{status:429,headers:{'x-rate-limit-remaining-day':'-27'}}),at),e=>e.retryAt==='2026-10-24T00:00:00.000Z');
});
test('после турнира остановка, чужому адресу секрет не отправляется',async()=>{
 assert.equal((await collect({at:STOP})).stopped,true);await assert.rejects(collect({token,site:'https://other.test',at}),/Неверный адрес/);
});
test('одна недоступная карта не останавливает очередь; старые ники не отправляются обратно как пустые',async()=>{
 let payload;const fetcher=async(url,options={})=>{if(url===cloud){if(options.method==='POST'){payload=JSON.parse(options.body);return Response.json({ok:true});}return Response.json({snapshot:{leagueId:20395,maps:[]}});}if(url.includes('/leagues/'))return Response.json([raw(1),raw(2)]);if(url.endsWith('/1'))throw Error('timeout');return Response.json({...raw(2),chat:[{private:'not exported'}]});};
 await assert.rejects(collect({token,fetcher,at,now:()=>at,wait:async()=>{}}),/временно недоступна/);assert.equal(payload.details.length,1);assert.equal(payload.details[0].match_id,2);assert.equal(payload.details[0].chat,undefined);
});
