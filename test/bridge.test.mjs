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
import { Manager } from '../src/manager.mjs';
import { EventEmitter } from 'node:events';
import { WORKFLOW_URI, WORKFLOW_PROMPT } from '../src/orchestration.mjs';
const fixture=fileURLToPath(new URL('./fake-codex.mjs',import.meta.url));
async function setup(t,history=false){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-bridge-test-')),cwd=path.join(root,'project');await fs.mkdir(cwd);
  const config={stateDir:path.join(root,'state'),roots:[cwd],command:process.execPath,commandArgs:[fixture,history?cwd:'','--store',path.join(root,'native.json')],requestTimeout:1500};
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

test('native history discovery includes external projects, providers, sources and archived pages',async t=>{
  const b=await setup(t,true);
  const first=await b.call('codex_history',{limit:1});
  assert.equal(first.conversations[0].thread_id,'history-cli');assert.equal(first.conversations[0].can_resume,true);
  assert.ok(first.next_cursor);
  const rest=await b.call('codex_history',{cursor:first.next_cursor});
  assert.deepEqual(rest.conversations.map(s=>s.thread_id),['history-vscode','history-subagent']);
  assert.equal(rest.conversations[0].can_resume,false);assert.equal(rest.next_cursor,null);
  const archived=await b.call('codex_history',{archived:true});assert.equal(archived.conversations[0].thread_id,'history-archived');
  const search=await b.call('codex_history',{query:'Router',cwd:b.cwd});assert.equal(search.conversations.length,1);
  await assert.rejects(b.call('codex_history',{archived:'true'}),/boolean/);
  assert.equal(b.manager.sessions.size,0,'discovery must not import any conversations');
});

test('native history reads remain read-only and paginate long Unicode messages without losing text',async t=>{
  const b=await setup(t,true);
  const outside=await b.call('codex_history_read',{thread_id:'history-vscode'});
  assert.equal(outside.messages.at(-1).text,'IDE answer');assert.equal(outside.can_resume,false);assert.equal(outside.read_only,true);
  assert.equal(outside.status.type,'notLoaded');assert.equal(b.manager.sessions.size,0);
  await assert.rejects(b.call('codex_resume',{thread_id:'history-vscode'}),/outside/);
  let cursor,answer='',pages=0;
  do {
    const page=await b.call('codex_history_read',{thread_id:'history-cli',...(cursor?{cursor}:{})});pages++;
    for(const message of page.messages)if(message.role==='assistant')answer+=message.text;
    cursor=page.next_cursor;
    if(cursor)await assert.rejects(b.call('codex_history_read',{thread_id:'history-subagent',cursor}),/another thread/);
  }while(cursor&&pages<10);
  assert.equal(pages,2);assert.equal(answer,'A'.repeat(47999)+'\u{1F680}'+'B'.repeat(3000));assert.equal(cursor,null);
  const one=await b.call('codex_history_read',{thread_id:'history-cli',limit:1});assert.equal(one.messages.length,1);assert.ok(one.next_cursor);
  await assert.rejects(b.call('codex_history_read',{thread_id:'history-cli',cursor:'garbage'}),/Invalid history cursor/);
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
  const d=await b.call('codex_send',{conversation_id:s.conversation_id,prompt:'DISCONNECT',request_id:'d'});assert.ok(['failed','disconnected','unknown'].includes(d.status));
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

test('delegation preserves user intent, executes a bounded brief, and returns a review packet across reloads',async t=>{
  const b=await setup(t),brief={user_request:'帮我创建一个文件，完成后告诉我怎么查看',goal:'CREATE a fixture file',
    context:'This project has a deterministic fixture.',scope:['Create fixture.txt in the project'],
    acceptance_criteria:['fixture.txt contains created by fixture'],constraints:['Preserve unrelated work'],assumptions:['Use a plain text file']};
  const args={cwd:b.cwd,brief,request_id:'delegate-1'};
  const s=await b.call('codex_delegate',args);
  assert.equal(b.manager.openSequence,0,'delegation must not require the user to read a technical panel');
  const done=await until(()=>b.call('codex_wait',{conversation_id:s.conversation_id,compact:true,timeout_ms:100}),x=>x.status==='completed');
  assert.equal(done.messages,undefined);assert.equal(done.events,undefined);assert.equal(done.next_cursor,b.manager.get(s.conversation_id).cursor);
  assert.equal(done.coordination.next_action,'review_result');assert.equal(done.coordination.acceptance_status,'not_assessed');
  assert.equal(await fs.readFile(path.join(b.cwd,'fixture.txt'),'utf8'),'created by fixture');
  const result=await b.call('codex_result',{conversation_id:s.conversation_id});
  assert.deepEqual(result.brief,brief);assert.match(result.report.text,/Original user request/);assert.match(result.report.text,/帮我创建一个文件/);
  assert.equal(result.verification.independently_verified,false);assert.equal(result.report.is_partial,false);
  assert.equal((await b.call('codex_delegate',args)).deduplicated,true);
  await assert.rejects(b.call('codex_delegate',{...args,brief:{...brief,goal:'different'}}),/different arguments/);
  await b.manager.save();
  const restored=new Manager(b.config,new EventEmitter());await restored.load();
  assert.deepEqual(restored.result({conversation_id:s.conversation_id}).brief,brief);
  assert.equal(restored.result({conversation_id:s.conversation_id}).report.text,result.report.text);
  await b.call('codex_open',{conversation_id:s.conversation_id});assert.equal(b.manager.openSequence,1);
});

test('result cannot reuse a prior success during a follow-up, steering or cancellation',async t=>{
  const b=await setup(t),s=await b.call('codex_start',{cwd:b.cwd,prompt:'first',request_id:'result-first'});
  await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),x=>x.status==='completed');
  assert.match((await b.call('codex_result',{conversation_id:s.conversation_id})).report.text,/first/);
  await b.call('codex_send',{conversation_id:s.conversation_id,prompt:'WAIT',request_id:'result-second'});
  await b.call('codex_send',{conversation_id:s.conversation_id,prompt:'new requirement',mode:'steer',request_id:'result-steer'});
  const active=await b.call('codex_result',{conversation_id:s.conversation_id});
  assert.equal(active.report.text,'');assert.equal(active.report.available,false);assert.equal(active.report.is_partial,true);
  assert.equal(active.coordination.next_action,'wait');
  await b.call('codex_cancel',{conversation_id:s.conversation_id});
  await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),x=>x.status==='cancelled');
  const cancelled=await b.call('codex_result',{conversation_id:s.conversation_id});
  assert.equal(cancelled.report.available,false);assert.equal(cancelled.coordination.review_required,false);
});

test('a changed user goal updates the saved brief in the same conversation',async t=>{
  const b=await setup(t),brief={user_request:'Explain the project',goal:'Explain the entry point',scope:['Read the entry point'],acceptance_criteria:['Describe startup']};
  const s=await b.call('codex_delegate',{cwd:b.cwd,brief,request_id:'brief-original'});
  await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),x=>x.status==='completed');
  const updated={...brief,user_request:'Also explain shutdown',goal:'Explain startup and shutdown',scope:['Read startup and shutdown'],acceptance_criteria:['Describe both lifecycle paths']};
  const args={conversation_id:s.conversation_id,brief:updated,prompt:'Focus the follow-up on shutdown.',request_id:'brief-revised'};
  const next=await b.call('codex_send',args);assert.equal(next.thread_id,s.thread_id);
  const pending=await b.call('codex_result',{conversation_id:s.conversation_id});assert.deepEqual(pending.brief,updated);assert.equal(pending.report.available,false);
  await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),x=>x.status==='completed');
  const result=await b.call('codex_result',{conversation_id:s.conversation_id});assert.match(result.report.text,/Explain startup and shutdown/);
  assert.match(result.report.text,/Focus the follow-up on shutdown/);assert.deepEqual(result.brief,updated);
  assert.equal((await b.call('codex_send',args)).deduplicated,true);assert.equal(b.manager.sessions.size,1);
});

test('result preserves all turn messages and paginates Unicode without dropping caveats',async t=>{
  const b=await setup(t),s=await b.call('codex_start',{cwd:b.cwd,prompt:'WAIT',request_id:'result-pages'});
  const session=b.manager.get(s.conversation_id),answer='A'.repeat(11999)+'🚀'+'B'.repeat(13000);
  b.manager.notification({method:'item/completed',params:{threadId:s.thread_id,turnId:session.turnId,item:{id:'final-result',type:'agentMessage',phase:'final_answer',text:answer}}});
  b.manager.notification({method:'item/completed',params:{threadId:s.thread_id,turnId:session.turnId,item:{id:'commentary-result',type:'agentMessage',phase:'commentary',text:'do not use this as the final report'}}});
  let offset=0,actual='',pages=0,report_id;
  do {const r=await b.call('codex_result',{conversation_id:s.conversation_id,offset,...(report_id?{report_id}:{})});actual+=r.report.text;offset=r.report.next_offset;report_id=r.report.report_id;pages++;assert.equal(r.report.source,'codex_turn_messages');}while(offset!==null&&pages<10);
  assert.equal(actual,answer+'\n\n'+'do not use this as the final report');assert.equal(pages,3);
  const tiny=await b.call('codex_result',{conversation_id:s.conversation_id,offset:11999,limit:1,report_id});assert.equal(tiny.report.text,'🚀');assert.equal(tiny.report.next_offset,12001);
  await assert.rejects(b.call('codex_result',{conversation_id:s.conversation_id,offset:actual.length+1,report_id}),/offset/);
});

test('delegation rejects missing goals, empty or oversized criteria and blank boundaries before starting work',async t=>{
  const b=await setup(t),brief={user_request:'Fix the issue',goal:'Restore expected behavior',scope:['Fix the identified cause'],acceptance_criteria:['The reported example works']};
  for(const bad of [{...brief,goal:' '},{...brief,acceptance_criteria:[]},{...brief,acceptance_criteria:Array(13).fill('criterion')},{...brief,scope:[' ']},{...brief,extra:'surprise'}]){
    await assert.rejects(b.call('codex_delegate',{cwd:b.cwd,brief:bad,request_id:'bad-brief'}));
  }
  assert.equal(b.manager.sessions.size,0);
});

test('orchestration guidance is available through MCP initialization, resources and prompts without starting Codex',async()=>{
  const input=new PassThrough(),output=new PassThrough();let raw='';output.setEncoding('utf8');output.on('data',x=>raw+=x);
  const serving=serveMcp({},input,output),send=m=>input.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
  send({id:0,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{}}});send({method:'notifications/initialized'});
  send({id:1,method:'resources/list'});send({id:2,method:'resources/read',params:{uri:WORKFLOW_URI}});
  send({id:3,method:'prompts/list'});send({id:4,method:'prompts/get',params:{name:WORKFLOW_PROMPT}});
  send({id:5,method:'prompts/get',params:{name:'missing'}});
  await until(async()=>raw,x=>x.includes('"id":5'));input.end();await serving;
  const rows=raw.trim().split('\n').map(JSON.parse),response=id=>rows.find(x=>x.id===id);
  assert.ok(response(0).result.capabilities.prompts);assert.match(response(0).result.instructions,/primary collaborator/);
  assert.ok(response(1).result.resources.some(x=>x.uri===WORKFLOW_URI));assert.equal(response(2).result.contents[0].mimeType,'text/markdown');
  assert.equal(response(3).result.prompts[0].name,WORKFLOW_PROMPT);assert.equal(response(4).result.messages[0].content.text,response(0).result.instructions);
  assert.equal(response(5).error.code,-32602);
});

const taskBrief={kind:'implementation',user_request:'帮我创建一个文本文件',goal:'CREATE the requested file',scope:['Create fixture.txt'],acceptance_criteria:['The requested text file exists']};
async function completedTask(b,key='review-task'){
  const s=await b.call('codex_delegate',{cwd:b.cwd,brief:taskBrief,request_id:key});
  await until(()=>b.call('codex_read',{conversation_id:s.conversation_id,compact:true}),x=>x.status==='completed');
  return {s,result:await b.call('codex_result',{conversation_id:s.conversation_id})};
}
function assessment(result,overrides={}){
  return {conversation_id:result.conversation_id,report_id:result.report.report_id,request_id:'review-1',verdict:'accepted',progress_made:true,
    assessments:[{criterion_index:0,status:'met',source:'host_observed',evidence:'Read fixture.txt and verified its contents'}],summary:'文件已经创建，可以直接打开查看',how_to_use:['Open fixture.txt'],limitations:[],...overrides};
}

test('review persists criteria evidence and prepares delivery without claiming the reply was sent',async t=>{
  const b=await setup(t),{s,result}=await completedTask(b);
  assert.equal(await fs.readFile(path.join(b.cwd,'fixture.txt'),'utf8'),'created by fixture');
  const reviewed=await b.call('codex_review',assessment(result));
  assert.equal(reviewed.coordination.phase,'ready_to_explain');assert.equal(reviewed.coordination.acceptance_status,'accepted');
  assert.equal(reviewed.coordination.delivery_status,'prepared_not_confirmed_sent');
  assert.equal((await b.call('codex_review',assessment(result))).deduplicated,true);
  const restored=new Manager(b.config,new EventEmitter());await restored.load();assert.equal(restored.result({conversation_id:s.conversation_id}).coordination.acceptance_status,'accepted');
  await b.call('codex_send',{conversation_id:s.conversation_id,prompt:'WAIT',request_id:'after-review'});
  assert.equal((await b.call('codex_read',{conversation_id:s.conversation_id})).coordination.acceptance_status,'not_assessed');
});

test('review refuses self-report-only acceptance, forged evidence and stale result identities',async t=>{
  const b=await setup(t),{s,result}=await completedTask(b);
  const base=assessment(result);
  await assert.rejects(b.call('codex_review',{...base,assessments:[{...base.assessments[0],source:'codex_claim'}]}),/self-report/);
  await assert.rejects(b.call('codex_review',{...base,assessments:[{...base.assessments[0],source:'codex_event',evidence_id:'invented'}]}),/evidence_id/);
  await assert.rejects(b.call('codex_review',{...base,report_id:'stale'}),/stale/);
  await assert.rejects(b.call('codex_result',{conversation_id:s.conversation_id,offset:1}),/report_id/);
  const event={threadId:s.thread_id,turnId:b.manager.get(s.conversation_id).turnId,item:{id:'check-1',type:'commandExecution',command:'check-fixture',status:'completed',exitCode:0,aggregatedOutput:'passed'}};
  b.manager.notification({method:'item/completed',params:event});
  await assert.rejects(b.call('codex_result',{conversation_id:s.conversation_id,offset:1,report_id:result.report.report_id}),/changed/);
  const current=await b.call('codex_result',{conversation_id:s.conversation_id});assert.equal(current.evidence[0].exit_code,0);
  const accepted=await b.call('codex_review',assessment(current,{assessments:[{criterion_index:0,status:'met',source:'codex_event',evidence_id:'check-1',evidence:'Observed the successful check result'}]}));
  assert.equal(accepted.coordination.review.observed_evidence[0].id,'check-1');
});

test('result includes an earlier failure even when the terminal message is brief and phase metadata is absent',async t=>{
  const b=await setup(t),s=await b.call('codex_start',{cwd:b.cwd,prompt:'WAIT',request_id:'earlier-caveat'}),turnId=b.manager.get(s.conversation_id).turnId;
  for(const [id,text] of [['failure','真实账号验证失败，尚未完成验收。'],['tail','修改涉及登录模块。']])
    b.manager.notification({method:'item/completed',params:{threadId:s.thread_id,turnId,item:{id,type:'agentMessage',text}}});
  const result=await b.call('codex_result',{conversation_id:s.conversation_id});assert.match(result.report.text,/验证失败/);assert.match(result.report.text,/登录模块/);
  assert.equal(result.report.message_count,2);
});

test('worker restart reconnects and continues the exact persisted thread without replaying prior work',async t=>{
  const b=await setup(t),{s}=await completedTask(b,'restart-completed'),oldPid=b.manager.client.child.pid;
  b.manager.client.child.kill();await until(async()=>b.manager.client.closed,x=>x===true);
  assert.equal((await b.call('codex_diagnose')).ok,true);assert.notEqual(b.manager.client.child.pid,oldPid);
  const recovered=await b.call('codex_recover',{conversation_id:s.conversation_id});assert.equal(recovered.status,'completed');
  const next=await b.call('codex_send',{conversation_id:s.conversation_id,prompt:'follow-up after reconnect',request_id:'restarted-follow-up'});assert.equal(next.thread_id,s.thread_id);
  await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),x=>x.status==='completed');
  const {thread}=await b.manager.client.request('thread/read',{threadId:s.thread_id,includeTurns:true});assert.equal(thread.turns.length,2);
});

test('lost mutation response stays uncertain after reconnect and is never automatically replayed',async t=>{
  const b=await setup(t),s=await b.call('codex_start',{cwd:b.cwd,prompt:'DISCONNECT',request_id:'lost-response'});
  assert.ok(['unknown','disconnected'].includes(s.status));
  const recovered=await b.call('codex_recover',{conversation_id:s.conversation_id});assert.equal(recovered.status,'unknown');
  await assert.rejects(b.call('codex_send',{conversation_id:s.conversation_id,prompt:'retry',request_id:'unsafe-retry'}),/indeterminate|active/);
  const {thread}=await b.manager.client.request('thread/read',{threadId:s.thread_id,includeTurns:true});assert.equal(thread.turns.length,1);
});

test('two distinct no-progress rounds stop blind repetition while review retries do not consume rounds',async t=>{
  const b=await setup(t),{s,result}=await completedTask(b,'no-progress');
  const failed=result=>assessment(result,{verdict:'needs_changes',progress_made:false,summary:'The requested behavior is still missing',assessments:[{criterion_index:0,status:'not_met',source:'host_observed',evidence:'Inspected the current behavior; the gap remains'}]});
  const first=await b.call('codex_review',failed(result));assert.equal(first.coordination.no_progress_rounds,1);
  assert.equal((await b.call('codex_review',{...failed(result),request_id:'same-report-amendment'})).coordination.no_progress_rounds,1);
  await b.call('codex_send',{conversation_id:s.conversation_id,prompt:'Try the focused correction',request_id:'correction-1'});
  await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),x=>x.status==='completed');
  const next=await b.call('codex_result',{conversation_id:s.conversation_id});
  const second=await b.call('codex_review',{...failed(next),request_id:'review-2'});assert.equal(second.coordination.next_action,'reconsider_or_report_blocker');
  await assert.rejects(b.call('codex_send',{conversation_id:s.conversation_id,prompt:'repeat',request_id:'repeat'}),/Two reviews/);
  await assert.rejects(b.call('codex_send',{conversation_id:s.conversation_id,prompt:'repeat',brief:taskBrief,request_id:'repeat-same-brief'}),/Two reviews/);
  const revised={...taskBrief,assumptions:['Investigate a different cause before attempting another fix']};
  await b.call('codex_send',{conversation_id:s.conversation_id,prompt:'Use the revised approach',brief:revised,request_id:'replanned'});
  assert.equal(b.manager.get(s.conversation_id).task.brief_revision,2);
});

test('research is read-only and reasoning effort follows the live model catalog without fixed enums',async t=>{
  const b=await setup(t),s=await b.call('codex_delegate',{cwd:b.cwd,brief:{...taskBrief,kind:'research'},reasoning_effort:'future-level',request_id:'catalog'});
  await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),x=>x.status==='completed');
  const {thread}=await b.manager.client.request('thread/read',{threadId:s.thread_id,includeTurns:true});assert.equal(thread.sandbox,'read-only');assert.equal(thread.turns[0].effort,'future-level');
  await assert.rejects(fs.access(path.join(b.cwd,'fixture.txt')));
  await assert.rejects(b.call('codex_delegate',{cwd:b.cwd,brief:{...taskBrief,kind:'research'},sandbox:'workspace-write',request_id:'unsafe-research'}),/read-only/);
  await assert.rejects(b.call('codex_start',{cwd:b.cwd,prompt:'x',reasoning_effort:'unavailable',request_id:'bad-effort'}),/not advertised/);
  const next=await b.call('codex_send',{conversation_id:s.conversation_id,prompt:'Now implement the authorized file creation',brief:taskBrief,sandbox:'workspace-write',request_id:'promote-research'});
  assert.equal(next.thread_id,s.thread_id);
  await until(()=>b.call('codex_read',{conversation_id:s.conversation_id}),x=>x.status==='completed');
  assert.equal(await fs.readFile(path.join(b.cwd,'fixture.txt'),'utf8'),'created by fixture');
});
