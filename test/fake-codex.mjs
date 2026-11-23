// Deterministic app-server fixture; not a real model.
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
const threads=new Map(),approvals=new Map();let n=0,initialized=false;
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
  if(m.method==='model/list'){reply(m.id,{data:[{id:'fixture-model',displayName:'Fixture'}]});continue;}
  if(m.method==='thread/start'){const t={id:'thread-'+(++n),cwd:p.cwd,turns:[]};threads.set(t.id,t);reply(m.id,{thread:t,model:'fixture-model'});continue;}
  const t=threads.get(p.threadId);
  if(!t){send({id:m.id,error:{code:-32000,message:'Thread not found'}});continue;}
  if(['thread/read','thread/resume'].includes(m.method)){reply(m.id,{thread:t});continue;}
  if(m.method==='turn/interrupt'){clearTimeout(t.timer);reply(m.id,{});notify('turn/completed',{threadId:t.id,turn:{id:t.turnId,status:'interrupted'}});continue;}
  if(m.method==='turn/steer'){reply(m.id,{turnId:t.turnId});continue;}
  if(m.method==='turn/start'){
    const turnId='turn-'+(++n);t.turnId=turnId;const text=p.input[0].text;
    if(text==='DISCONNECT')process.exit(2);
    reply(m.id,{turn:{id:turnId,status:'inProgress'}});notify('turn/started',{threadId:t.id,turn:{id:turnId,status:'inProgress'}});
    const done=async(accepted=true)=>{
      const id='message-'+n,answer=accepted?'Fixture completed: '+text:'Fixture approval declined';
      if(text.includes('CREATE')&&accepted)await fs.writeFile(path.join(t.cwd,'fixture.txt'),'created by fixture');
      notify('item/agentMessage/delta',{threadId:t.id,turnId,itemId:id,delta:answer.slice(0,8)});
      notify('item/agentMessage/delta',{threadId:t.id,turnId,itemId:id,delta:answer.slice(8)});
      const item={id,type:'agentMessage',text:answer};t.turns.push({id:turnId,items:[{id:'u-'+n,type:'userMessage',content:[{type:'text',text}]},item]});
      notify('item/completed',{threadId:t.id,turnId,item});notify('turn/completed',{threadId:t.id,turn:{id:turnId,status:text==='FAIL'?'failed':'completed',...(text==='FAIL'?{error:{message:'Fixture failure'}}:{})}});
    };
    if(text==='APPROVE'){const id=100+n;approvals.set(id,done);setTimeout(()=>send({id,method:'item/commandExecution/requestApproval',params:{threadId:t.id,turnId,itemId:'cmd',command:'echo test',cwd:t.cwd}}),10);}
    else if(text!=='WAIT')t.timer=setTimeout(()=>done(),45);
    continue;
  }
  send({id:m.id,error:{code:-32601,message:'Method not found'}});
}
