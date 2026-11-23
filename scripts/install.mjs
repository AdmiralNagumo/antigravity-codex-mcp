#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { allowedDirectory } from '../src/config.mjs';
import { prepareSkill, installConfiguration } from '../src/install-skill.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2),values={};let write=false;
for(let i=0;i<args.length;i++){if(args[i]==='--write')write=true;else if(['--project','--config','--state-dir','--codex','--skill-dir','--scope'].includes(args[i])){const value=args[++i];if(!value||value.startsWith('--'))throw new Error('Missing installer argument value');values[args[i-1].slice(2)]=value;}else throw new Error('Usage: node scripts/install.mjs --project ABSOLUTE_PATH [--config MCP_CONFIG_JSON] [--state-dir PATH] [--codex PATH] [--scope global|project] [--skill-dir PATH] [--write]');}
if(!values.project)throw new Error('--project is required');
const project=allowedDirectory(path.resolve(values.project),[await fs.realpath(path.resolve(values.project))]);
const filename=path.resolve(values.config||path.join(os.homedir(),'.gemini','config','mcp_config.json'));
if(values.scope&&!['global','project'].includes(values.scope))throw new Error('--scope must be global or project');
const skillDirectory=path.resolve(values['skill-dir']||(values.scope==='project'?path.join(project,'.agents','skills','codex-coordinator'):path.join(os.homedir(),'.gemini','config','skills','codex-coordinator')));
const skill=await prepareSkill(root,skillDirectory);
let data={};try{const text=(await fs.readFile(filename,'utf8')).replace(/^\uFEFF/,'').trim();data=text?JSON.parse(text):{};}catch(error){if(error.code!=='ENOENT')throw error;}
if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('MCP config must be a JSON object');
data.mcpServers??={};if(typeof data.mcpServers!=='object'||Array.isArray(data.mcpServers))throw new Error('mcpServers must be a JSON object');
const previous=data.mcpServers.codex&&typeof data.mcpServers.codex==='object'?data.mcpServers.codex:{};
const previousArgs=Array.isArray(previous.args)?previous.args:[];
const flagValues=flag=>previousArgs.flatMap((value,index)=>value===flag&&typeof previousArgs[index+1]==='string'?[previousArgs[index+1]]:[]);
const stateDir=path.resolve(values['state-dir']||flagValues('--state-dir')[0]||path.join(os.homedir(),'.antigravity-codex'));
const codex=values.codex||flagValues('--codex')[0];
const roots=[...new Set([...flagValues('--allow-root'),project])];
const commandArgs=values.codex?[]:flagValues('--codex-arg');
const timeout=flagValues('--request-timeout')[0];
const server={...previous,command:process.execPath,args:[path.join(root,'bin','bridge.mjs'),'--state-dir',stateDir,...roots.flatMap(r=>['--allow-root',r]),...(codex?['--codex',codex]:[]),...commandArgs.flatMap(a=>['--codex-arg',a]),...(timeout?['--request-timeout',timeout]:[])],cwd:project,timeoutSeconds:previous.timeoutSeconds??120};
data.mcpServers.codex=server;
if(write){const installed=await installConfiguration(filename,data,skill,path.join(stateDir,'installer-backups'));console.log(JSON.stringify({...installed,allowed_project:project},null,2));console.log('Refresh Antigravity skills and the MCP connection after stopping any old bridge daemon. Tell Antigravity your goal; the technical panel is optional.');}
else console.log(JSON.stringify({config_file:filename,configuration:data,skill_directory:skill.target,skill_files:skill.files.map(f=>f.path)},null,2));
