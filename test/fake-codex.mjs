// Deterministic app-server fixture; not a real model.
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
const threads=new Map(),approvals=new Map();let n=0,initialized=false;
const storeIndex=process.argv.indexOf('--store'),storeFile=storeIndex>=0?process.argv[storeIndex+1]:null;
if(storeFile){try{const data=JSON.parse(await fs.readFile(storeFile,'utf8'));n=data.n;for(const t of data.threads)threads.set(t.id,t);}catch(error){if(error.code!=='ENOENT')throw error;}}
async function persist(){if(storeFile)await fs.writeFile(storeFile,JSON.stringify({n,threads:[...threads.values()]},(key,value)=>key==='timer'?undefined:value));}
if(process.argv[2]) {
  const cwd=process.argv[2];
  const seed=(id,name,source,modelProvider,updatedAt,archived,project,text)=>threads.set(id,{id,name,preview:name,source,modelProvider,createdAt:1,updatedAt,archived,cwd:project,status:{type:'notLoaded'},turns:[{id:'history-turn-'+id,status:'completed',items:[{id:'history-user-'+id,type:'userMessage',content:[{type:'text',text:'Previous question'}]},{id:'history-answer-'+id,type:'agentMessage',text}]}]});
  seed('history-cli','Router research','cli','openai',4,false,cwd,'A'.repeat(47999)+'\u{1F680}'+'B'.repeat(3000));
  seed('history-vscode','Old IDE conversation','vscode','custom-provider',3,false,path.dirname(cwd),'IDE answer');
  seed('history-subagent','Review result','subAgentReview','openai',2,false,cwd,'Review answer');
  seed('history-archived','Archived research','cli','openai',1,true,cwd,'Archived answer');
}
const send=o=>process.stdout.write(JSON.stringify(o)+'\n');
const reply=(id,result)=>send({id,result});
const notify=(method,params)=>send({method,params});
for await(const line of createInterface({input:process.stdin})){
  let m;try{m=JSON.parse(line);}catch{continue;}
  if(!m.method){const action=approvals.get(m.id);if(action){approvals.delete(m.id);action(m.result?.decision==='accept');}continue;}
  const p=m.params||{};
  if(m.method==='initialize'){reply(m.id,{userAgent:'fake-codex/1.0',platformFamily:'test'});continue;}
  if(m.method==='initialized'){initialized=true;continue;}
  if(!initialized){send({id:m.id,error:{code:-32000,message:'Not initialized'}});continue;}
  if(m.method==='model/list'){reply(m.id,{data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'future-level'}]}]});continue;}
  if(m.method==='thread/start'){const t={id:'thread-'+(++n),cwd:p.cwd,sandbox:p.sandbox,turns:[]};threads.set(t.id,t);await persist();reply(m.id,{thread:t,model:'fixture-model'});continue;}
  if(m.method==='thread/list'){
    const sources=p.sourceKinds?.length?p.sourceKinds:['cli','vscode','appServer'];
    const data=[...threads.values()].filter(t=>Boolean(t.archived)===Boolean(p.archived)&&sources.includes(t.source)&&
      (!p.modelProviders||p.modelProviders.length===0||p.modelProviders.includes(t.modelProvider))&&
      (!p.cwd||t.cwd===p.cwd)&&(!p.searchTerm||(t.name||'').toLowerCase().includes(p.searchTerm.toLowerCase())))
      .sort((a,b)=>b.updatedAt-a.updatedAt);
    const start=Number(p.cursor||0),limit=p.limit||50;
    reply(m.id,{data:data.slice(start,start+limit).map(t=>({...t,turns:[]})),nextCursor:start+limit<data.length?String(start+limit):null});continue;
  }
  const t=threads.get(p.threadId);
  if(!t){send({id:m.id,error:{code:-32000,message:'Thread not found'}});continue;}
  if(['thread/read','thread/resume'].includes(m.method)){if(m.method==='thread/resume'&&p.sandbox){t.sandbox=p.sandbox;await persist();}reply(m.id,{thread:t});continue;}
  if(m.method==='turn/interrupt'){clearTimeout(t.timer);if(t.turns.at(-1))t.turns.at(-1).status='interrupted';await persist();reply(m.id,{});notify('turn/completed',{threadId:t.id,turn:{id:t.turnId,status:'interrupted'}});continue;}
  if(m.method==='turn/steer'){reply(m.id,{turnId:t.turnId});continue;}
  if(m.method==='turn/start'){
    const turnId='turn-'+(++n);t.turnId=turnId;const text=p.input[0].text;
    const turn={id:turnId,status:'inProgress',effort:p.effort,items:[{id:'u-'+n,type:'userMessage',content:[{type:'text',text}]}]};t.turns.push(turn);await persist();
    if(text==='DISCONNECT')process.exit(2);
    reply(m.id,{turn:{id:turnId,status:'inProgress'}});notify('turn/started',{threadId:t.id,turn:{id:turnId,status:'inProgress'}});
    const done=async(accepted=true)=>{
      const id='message-'+n,answer=accepted?'Fixture completed: '+text:'Fixture approval declined';
      if(text.includes('CREATE')&&accepted&&t.sandbox!=='read-only')await fs.writeFile(path.join(t.cwd,'fixture.txt'),'created by fixture');
      notify('item/agentMessage/delta',{threadId:t.id,turnId,itemId:id,delta:answer.slice(0,8)});
      notify('item/agentMessage/delta',{threadId:t.id,turnId,itemId:id,delta:answer.slice(8)});
      const item={id,type:'agentMessage',text:answer};turn.items.push(item);turn.status=text==='FAIL'?'failed':'completed';await persist();
      notify('item/completed',{threadId:t.id,turnId,item});notify('turn/completed',{threadId:t.id,turn:{id:turnId,status:text==='FAIL'?'failed':'completed',...(text==='FAIL'?{error:{message:'Fixture failure'}}:{})}});
    };
    if(text==='APPROVE'){const id=100+n;approvals.set(id,done);setTimeout(()=>send({id,method:'item/commandExecution/requestApproval',params:{threadId:t.id,turnId,itemId:'cmd',command:'echo test',cwd:t.cwd}}),10);}
    else if(text!=='WAIT')t.timer=setTimeout(()=>done(),45);
    continue;
  }
  send({id:m.id,error:{code:-32601,message:'Method not found'}});
}
