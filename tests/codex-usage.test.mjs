import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createCodexUsage, normalizeRateLimits, readCodexLimits } from '../server/codex-usage.mjs';
import { createServer } from '../server/index.mjs';

const sample = {rateLimitsByLimitId: {codex: {limitName: null, primary: {usedPercent: 37, windowDurationMins: 10080, resetsAt: 1793898171}, secondary: {usedPercent: null, windowDurationMins: 300, resetsAt: null}}, other: {limitName: 'other-model', primary: {usedPercent: 110, windowDurationMins: 60, resetsAt: 5}, secondary: null}}};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('quota normalization handles multiple buckets, both windows, nulls and legacy response', () => {
  assert.deepEqual(normalizeRateLimits(sample), [
    {label:'codex', remainingPercent:63, windowDurationMins:10080, resetsAt:1793898171},
    {label:'codex', remainingPercent:null, windowDurationMins:300, resetsAt:null},
    {label:'other-model', remainingPercent:0, windowDurationMins:60, resetsAt:5},
  ]);
  assert.deepEqual(normalizeRateLimits({rateLimits:{limitId:'codex', primary:{usedPercent:-10, windowDurationMins:0, resetsAt:0}}}), [{label:'codex', remainingPercent:100, windowDurationMins:null,resetsAt:null}]);
  assert.deepEqual(normalizeRateLimits({rateLimits:null}), []);
});

test('cache coalesces concurrent reads, throttles failures, keeps stale data and recovers', async () => {
  let clock = Date.UTC(2026,10,2); let calls = 0; let rejectNext = false;
  const cache = createCodexUsage({now:()=>clock,cacheMs:300000,query:async()=>{calls++; if (rejectNext) throw Error('offline'); return sample;}});
  assert.deepEqual(cache.read(), {available:false,updatedAt:null,windows:[],stale:false,errorCode:null,refreshing:true});
  cache.read();cache.read();await tick();assert.equal(calls,1);
  assert.equal(cache.read().windows[0].remainingPercent,63);assert.equal(cache.read().stale,false);
  clock += 300000;rejectNext=true;assert.equal(cache.read().stale,true);await tick();assert.equal(calls,2);assert.equal(cache.read().stale,true);await tick();assert.equal(calls,2);
  clock += 300000;rejectNext=false;cache.read();await tick();assert.equal(calls,3);assert.equal(cache.read().stale,false);cache.close();
});

test('official stdio protocol succeeds and hung child is bounded', async t => {
  const dir=mkdtempSync(join(tmpdir(),'codex-usage-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const executable=join(dir,'fake-codex');
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdin.setEncoding('utf8');let b='';process.stdin.on('data',x=>{b+=x;let n;while((n=b.indexOf('\\n'))>=0){let l=b.slice(0,n);b=b.slice(n+1);let m=JSON.parse(l);if(m.method==='initialize')console.log(JSON.stringify({id:1,result:{}}));if(m.method==='account/rateLimits/read')console.log(JSON.stringify({id:2,result:${JSON.stringify(sample)}}));}});`,{mode:0o700});
  // A loaded macOS machine may take several seconds to start a fresh Node
  // subprocess. Keep the separate 100 ms hung-child test below strict.
  assert.equal(normalizeRateLimits(await readCodexLimits({command:executable,timeoutMs:10000}))[0].remainingPercent,63);
  writeFileSync(executable,`#!${process.execPath}\nsetInterval(()=>{},1000);`,{mode:0o700});
  await assert.rejects(readCodexLimits({command:executable,timeoutMs:100}),/超时/);
  await assert.rejects(readCodexLimits({command:join(dir,'missing'),timeoutMs:500}),/不可用/);
});

test('HTTP quota route enforces origin and isolates quota failure from task state', async t => {
  const dir=mkdtempSync(join(tmpdir(),'codex-usage-http-'));const usage=createCodexUsage({query:async()=>{throw Error('offline')}});
  const server=createServer({dataDir:dir,codexUsage:usage});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true})});
  const base=`http://127.0.0.1:${server.address().port}`;
  let r=await fetch(base+'/api/codex-usage');assert.equal(r.status,200);assert.equal((await r.json()).available,false);await tick();
  r=await fetch(base+'/api/codex-usage',{headers:{origin:'https://evil.test'}});assert.equal(r.status,403);
  r=await fetch(base+'/api/state');assert.equal(r.status,200);assert.equal((await r.json()).revision,0);
});

test('manual refresh bypasses cache, waits for coalesced request and enforces short cooldown', async () => {
  let clock = 100000; let calls=0; let release;
  const cache=createCodexUsage({now:()=>clock,query:()=>{calls++;return new Promise(resolve=>{release=resolve})}});
  cache.read();await tick();
  const first=cache.refresh();const second=cache.refresh();await tick();assert.equal(calls,1);
  release(sample);const [a,b]=await Promise.all([first,second]);assert.equal(a.refreshStatus,'updated');assert.equal(b.refreshStatus,'updated');assert.equal(a.refreshing,false);
  const tooSoon=await cache.refresh();assert.equal(tooSoon.refreshStatus,'throttled');assert.equal(tooSoon.retryAfterSeconds,15);assert.equal(calls,1);
  clock+=15000;const next=cache.refresh();await tick();assert.equal(calls,2);release(sample);assert.equal((await next).refreshStatus,'updated');cache.close();
});

test('failure returns only safe diagnostics, preserves stale snapshot and manual refresh recovers', async () => {
  let clock=100000;let fail=false;
  const cache=createCodexUsage({now:()=>clock,query:async()=>{if(fail)throw Error('401 authentication secret-should-not-leak');return sample}});
  let r=await cache.refresh();assert.equal(r.refreshStatus,'updated');
  clock+=15000;fail=true;r=await cache.refresh();assert.equal(r.refreshStatus,'failed');assert.equal(r.errorCode,'authentication');assert.equal(r.stale,true);assert.equal(r.windows[0].remainingPercent,63);assert.doesNotMatch(JSON.stringify(r),/secret-should-not-leak/);
  clock+=15000;fail=false;r=await cache.refresh();assert.equal(r.refreshStatus,'updated');assert.equal(r.errorCode,null);assert.equal(r.stale,false);cache.close();
});

test('manual refresh HTTP requires trusted origin, header and JSON and awaits result', async t => {
  const dir=mkdtempSync(join(tmpdir(),'codex-manual-http-'));let release;let calls=0;
  const usage=createCodexUsage({query:()=>{calls++;return new Promise(resolve=>{release=resolve})}});
  const server=createServer({dataDir:dir,codexUsage:usage});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true})});
  const base=`http://127.0.0.1:${server.address().port}`;const post=(headers={},body='{}')=>fetch(base+'/api/codex-usage/refresh',{method:'POST',headers:{'content-type':'application/json',...headers},body});
  assert.equal((await post()).status,403);
  assert.equal((await post({'x-daily-planner':'1',origin:'https://evil.test'})).status,403);
  assert.equal((await post({'x-daily-planner':'1','sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await post({'x-daily-planner':'1'},'{bad')).status,400);
  assert.equal((await post({'x-daily-planner':'1'},'{"unexpected":true}')).status,400);
  let settled=false;const pending=post({'x-daily-planner':'1'}).then(r=>{settled=true;return r});
  for(let i=0;i<10&&!release;i++) await tick();assert.equal(calls,1);assert.equal(settled,false);release(sample);
  const response=await pending;assert.equal(response.status,200);const result=await response.json();assert.equal(result.refreshStatus,'updated');assert.equal(result.windows[0].remainingPercent,63);
  assert.equal((await (await post({'x-daily-planner':'1'})).json()).refreshStatus,'throttled');
});

test('process diagnostics classify RPC and stderr failures without leaking private text', async t => {
  const dir=mkdtempSync(join(tmpdir(),'codex-error-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const executable=join(dir,'fake-codex');
  writeFileSync(executable,`#!${process.execPath}\nprocess.stdin.setEncoding('utf8');let b='';process.stdin.on('data',x=>{b+=x;let n;while((n=b.indexOf('\\n'))>=0){let m=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(m.method==='initialize')console.log(JSON.stringify({id:1,result:{}}));if(m.method==='account/rateLimits/read')console.log(JSON.stringify({id:2,error:{message:'401 unauthorized PRIVATE_DATA'}}));}});`,{mode:0o700});
  await assert.rejects(readCodexLimits({command:executable,timeoutMs:10000}),e=>e.usageCode==='authentication' && !e.message.includes('PRIVATE_DATA'));
  writeFileSync(executable,`#!${process.execPath}\nconsole.error('network connection refused PRIVATE_DATA');process.exit(1);`,{mode:0o700});
  await assert.rejects(readCodexLimits({command:executable,timeoutMs:10000}),e=>e.usageCode==='network' && !e.message.includes('PRIVATE_DATA'));
});
