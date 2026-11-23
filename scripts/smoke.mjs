// Opt-in local Codex verification. Does not read or print authentication files.
import fs from 'node:fs/promises';
import path from 'node:path';
import { options } from '../src/config.mjs';
import { CodexClient } from '../src/codex.mjs';
import { startDaemon } from '../src/daemon.mjs';
import { sleep } from '../src/runtime.mjs';
import { dispatch } from '../src/tools.mjs';
const live=process.argv.includes('--live-task');
const isolated=process.argv.includes('--isolated-home');
const directory=path.resolve('.scratch','smoke-'+Date.now()),cwd=path.join(directory,'project');await fs.mkdir(cwd,{recursive:true});
const config=options(process.argv.slice(2).filter(x=>!['--live-task','--isolated-home'].includes(x)));
if(isolated){process.env.CODEX_HOME=path.join(directory,'codex-home');await fs.mkdir(process.env.CODEX_HOME,{recursive:true});}
config.roots=[cwd];config.stateDir=path.join(directory,'state');
const client=new CodexClient(config),daemon=await startDaemon(config,client);
const api=(_runtime,name,args)=>dispatch(daemon.manager,name,args);
try{
  const diagnosis=await api(daemon.runtime,'codex_diagnose');console.log(JSON.stringify({stage:'app-server-handshake',ok:diagnosis.ok,codex:diagnosis.codex}));
  const history=await api(daemon.runtime,'codex_history',{limit:1});console.log(JSON.stringify({stage:'native-history-discovery',ok:true,returned:history.conversations.length,has_more:history.next_cursor!==null}));
  if(live){
    let brief={kind:'implementation',user_request:'Create a text file and then update it in the same conversation',goal:'Create smoke.txt containing exactly bridge-ok followed by a newline',scope:['Only edit smoke.txt'],acceptance_criteria:['smoke.txt contains bridge-ok followed by a newline'],constraints:['Do not edit other files']};
    const start=await api(daemon.runtime,'codex_delegate',{cwd,brief,request_id:'smoke-start',sandbox:'workspace-write'});
    console.log(JSON.stringify({stage:'start',conversation_id:start.conversation_id,thread_id:start.thread_id}));
    for(let round=0;round<2;round++){
      const deadline=Date.now()+180000;let result;
      while(Date.now()<deadline){result=await api(daemon.runtime,'codex_wait',{conversation_id:start.conversation_id,after:result?.next_cursor||0,timeout_ms:1000,compact:true});if(!['running','starting'].includes(result.status))break;await sleep(200);}
      if(result?.status!=='completed')throw new Error('Live task did not complete: '+JSON.stringify({status:result?.status,error:result?.error,pending_requests:result?.pending_requests}));
      const text=await fs.readFile(path.join(cwd,'smoke.txt'),'utf8');
      if(text.trim()!==(round===0?'bridge-ok':'bridge-follow-up-ok'))throw new Error('Live file verification failed: '+text);
      console.log(JSON.stringify({stage:round===0?'live-file-edit':'live-follow-up',ok:true,status:result.status}));
      const packet=await api(daemon.runtime,'codex_result',{conversation_id:start.conversation_id});
      const review=await api(daemon.runtime,'codex_review',{conversation_id:start.conversation_id,report_id:packet.report.report_id,request_id:'smoke-review-'+round,verdict:'accepted',progress_made:true,
        assessments:[{criterion_index:0,status:'met',source:'host_observed',evidence:'Read the generated file and compared its exact contents'}],summary:'The requested text file is ready',how_to_use:['Open smoke.txt'],limitations:[]});
      if(review.coordination.phase!=='ready_to_explain')throw new Error('Live review was not persisted');
      if(round===0){brief={...brief,goal:'Update smoke.txt to bridge-follow-up-ok',acceptance_criteria:['smoke.txt contains bridge-follow-up-ok followed by a newline']};await api(daemon.runtime,'codex_send',{conversation_id:start.conversation_id,brief,prompt:'Replace smoke.txt contents with exactly bridge-follow-up-ok followed by a newline. Do not edit any other files.',request_id:'smoke-followup'});}
    }
  }
}catch(error){console.error(error.message);if(client.stderr)console.error(client.stderr.slice(-1500));process.exitCode=1;}
finally{await daemon.close();}
