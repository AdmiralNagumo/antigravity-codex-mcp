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
  if(live){
    const start=await api(daemon.runtime,'codex_start',{cwd,prompt:'Create smoke.txt in the current project containing exactly bridge-ok followed by a newline. Do not edit any other files. Report completion.',request_id:'smoke-start',sandbox:'workspace-write'});
    console.log(JSON.stringify({stage:'start',conversation_id:start.conversation_id,thread_id:start.thread_id}));
    for(let round=0;round<2;round++){
      const deadline=Date.now()+180000;let result;
      while(Date.now()<deadline){result=await api(daemon.runtime,'codex_wait',{conversation_id:start.conversation_id,after:result?.cursor||0,timeout_ms:1000});if(!['running','starting'].includes(result.status))break;await sleep(200);}
      if(result?.status!=='completed')throw new Error('Live task did not complete: '+JSON.stringify({status:result?.status,error:result?.error,pending_requests:result?.pending_requests}));
      const text=await fs.readFile(path.join(cwd,'smoke.txt'),'utf8');
      if(text.trim()!==(round===0?'bridge-ok':'bridge-follow-up-ok'))throw new Error('Live file verification failed: '+text);
      console.log(JSON.stringify({stage:round===0?'live-file-edit':'live-follow-up',ok:true,status:result.status}));
      if(round===0)await api(daemon.runtime,'codex_send',{conversation_id:start.conversation_id,prompt:'Replace smoke.txt contents with exactly bridge-follow-up-ok followed by a newline. Do not edit any other files.',request_id:'smoke-followup'});
    }
  }
}catch(error){console.error(error.message);if(client.stderr)console.error(client.stderr.slice(-1500));process.exitCode=1;}
finally{await daemon.close();}
