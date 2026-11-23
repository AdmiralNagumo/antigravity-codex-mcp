import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../src/daemon.mjs';
import { api, sleep } from '../src/runtime.mjs';
import { allowedDirectory } from '../src/config.mjs';
import { serveMcp } from '../src/mcp.mjs';
import { UI_URI, TOOLS, dispatch } from '../src/tools.mjs';
const fixture=fileURLToPath(new URL('./fake-codex.mjs',import.meta.url));
async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-bridge-test-')),cwd=path.join(root,'project');await fs.mkdir(cwd);
  const config={stateDir:path.join(root,'state'),roots:[cwd],command:process.execPath,commandArgs:[fixture],requestTimeout:1500};
  const daemon=await startDaemon(config);
  t.after(async()=>{await daemon.close();await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  return {...daemon,config,cwd,call:(name,args)=>dispatch(daemon.manager,name,args)};
}
async function until(fn,check,timeout=2500){const end=Date.now()+timeout;let result;while(Date.now()<end){result=await fn();if(check(result))return result;await sleep(20);}assert.fail('State did not converge: '+JSON.stringify(result));}
test('real process protocol: start, stream, file effect, follow-up, idempotency, persistence',async t=>{
  const b=await setup(t);assert.equal((await b.call('codex_diagnose')).ok,true);
  const args={cwd:b.cwd,prompt:'CREATE',request_id:'start-1'},s=await b.call('codex_start',args);
  const done=await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),s=>s.status==='completed');
  assert.equal(await fs.readFile(path.join(b.cwd,'fixture.txt'),'utf8'),'created by fixture');
  assert.equal(done.messages.filter(m=>m.role==='assistant').length,1);assert.match(done.messages.at(-1).text,/Fixture completed/);
  const duplicate=await b.call('codex_start',args);assert.equal(duplicate.conversation_id,s.conversation_id);assert.equal(duplicate.deduplicated,true);
  const reordered=await b.call('codex_start',{request_id:args.request_id,prompt:args.prompt,cwd:args.cwd});assert.equal(reordered.deduplicated,true);
  await assert.rejects(b.call('codex_start',{...args,prompt:'different'}),/different arguments/);
  const sent=await b.call('codex_send',{conversation_id:s.conversation_id,prompt:'follow-up',request_id:'send-1'});assert.equal(sent.thread_id,s.thread_id);
  const next=await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),s=>s.status==='completed');assert.equal(next.messages.length,4);
  await b.manager.save();const state=JSON.parse(await fs.readFile(path.join(b.config.stateDir,'sessions.json'),'utf8'));assert.equal(state.sessions[0].messages.length,4);
  assert.equal((await b.call('codex_open',{conversation_id:s.conversation_id})).open_conversation,s.conversation_id);
});
test('approval and scoped resolution are explicit',async t=>{
  const b=await setup(t),s=await b.call('codex_start',{cwd:b.cwd,prompt:'APPROVE',request_id:'a'});
  const waiting=await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),s=>s.status==='waiting_approval');assert.equal(waiting.pending_requests.length,1);
  await assert.rejects(b.call('codex_respond',{conversation_id:s.conversation_id,request_id:'wrong',decision:'accept'}),/expired/);
  await b.call('codex_respond',{conversation_id:s.conversation_id,request_id:waiting.pending_requests[0].request_id,decision:'decline'});
  const done=await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),s=>s.status==='completed');assert.match(done.messages.at(-1).text,/declined/);
});
test('workspace concurrency, steering, cancellation',async t=>{
  const b=await setup(t),s=await b.call('codex_start',{cwd:b.cwd,prompt:'WAIT',request_id:'w'});
  await assert.rejects(b.call('codex_start',{cwd:b.cwd,prompt:'other',request_id:'x'}),/active Codex turn/);
  await assert.rejects(b.call('codex_send',{conversation_id:s.conversation_id,prompt:'new',request_id:'n'}),/active/);
  await b.call('codex_send',{conversation_id:s.conversation_id,prompt:'update',mode:'steer',request_id:'steer'});
  await b.call('codex_cancel',{conversation_id:s.conversation_id});
  const stopped=await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),s=>s.status==='cancelled');assert.equal(stopped.messages.at(-1).text,'update');
});
test('loopback authentication, origin rejection, root boundaries, validation',async t=>{
  const b=await setup(t);
  await assert.rejects(b.call('codex_start',{cwd:path.dirname(b.cwd),prompt:'x',request_id:'r'}),/outside/);
  await assert.rejects(b.call('codex_start',{cwd:b.cwd,prompt:'x',request_id:'r',sandbox:'danger-full-access'}),/one of/);
  await assert.rejects(b.call('codex_read',{conversation_id:'x',after:-1}),/range/);
  await assert.rejects(b.call('codex_list',{unexpected:true}),/Unknown argument/);assert.equal(allowedDirectory(b.cwd,[b.cwd]),b.cwd);
});
test('HTTP transport authenticates, rejects browser origins and serves tools',async t=>{
  const b=await setup(t);
  try{assert.equal((await fetch(b.runtime.url+'/health')).status,403);}
  catch(error){if(['EACCES','EPERM'].includes(error.cause?.code)){t.skip('Host sandbox prohibits loopback connections; core protocol is tested over child stdio');return;}throw error;}
  assert.equal((await fetch(b.runtime.url+'/health',{headers:{Authorization:`Bearer ${b.runtime.token}`,Origin:'https://example.com'}})).status,403);
  assert.equal((await api(b.runtime,'codex_diagnose')).ok,true);
  const input=new PassThrough(),output=new PassThrough();let raw='';output.setEncoding('utf8');output.on('data',x=>raw+=x);
  const serving=serveMcp(b.config,input,output);
  const send=m=>input.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
  send({id:0,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{}}});send({method:'notifications/initialized'});
  send({id:1,method:'tools/call',params:{name:'codex_start',arguments:{cwd:b.cwd,prompt:'CREATE',request_id:'mcp-e2e'}}});
  await until(async()=>raw,x=>x.includes('"id":1'));
  const result=raw.trim().split('\n').map(JSON.parse).find(x=>x.id===1).result;
  assert.equal(result.isError,undefined);
  const id=result.structuredContent.conversation_id;
  await until(()=>api(b.runtime,'codex_read',{conversation_id:id}),x=>x.status==='completed');
  assert.equal(await fs.readFile(path.join(b.cwd,'fixture.txt'),'utf8'),'created by fixture');
  input.end();await serving;
});
test('simultaneous starts never create competing project writers',async t=>{
  const b=await setup(t);
  const results=await Promise.allSettled([b.call('codex_start',{cwd:b.cwd,prompt:'WAIT',request_id:'first'}),b.call('codex_start',{cwd:b.cwd,prompt:'WAIT',request_id:'second'})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(b.manager.sessions.size,1);
});
test('failure and process disconnect never report success',async t=>{
  const b=await setup(t),s=await b.call('codex_start',{cwd:b.cwd,prompt:'FAIL',request_id:'f'});
  const failed=await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),s=>s.status==='failed');assert.match(failed.error,/Fixture failure/);
  const d=await b.call('codex_send',{conversation_id:s.conversation_id,prompt:'DISCONNECT',request_id:'d'});assert.ok(['failed','disconnected'].includes(d.status));
});
test('stdio MCP handshake, concurrent requests, malformed JSON, app resource',async()=>{
  const input=new PassThrough(),output=new PassThrough();let raw='';output.setEncoding('utf8');output.on('data',x=>raw+=x);
  const serving=serveMcp({},input,output),send=m=>input.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
  send({id:0,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{extensions:{'io.modelcontextprotocol/ui':{}}}}});send({method:'notifications/initialized'});
  send({id:1,method:'tools/list'});send({id:2,method:'resources/read',params:{uri:UI_URI}});send({id:3,method:'no-such-method'});input.write('invalid\nnull\n[]\n42\n');
  await until(async()=>raw,x=>x.includes('"id":2'));input.end();await serving;
  const messages=raw.trim().split('\n').map(JSON.parse);assert.equal(messages.find(x=>x.id===0).result.protocolVersion,'2025-06-18');
  assert.equal(messages.find(x=>x.id===1).result.tools.length,TOOLS.length);assert.match(messages.find(x=>x.id===2).result.contents[0].text,/ui\/initialize/);
  assert.equal(messages.find(x=>x.id===3).error.code,-32601);assert.ok(messages.some(x=>x.error?.code===-32700));
  assert.equal(messages.filter(x=>x.error?.code===-32600).length,3);
});
