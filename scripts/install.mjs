#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { allowedDirectory } from '../src/config.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2),values={};let write=false;
for(let i=0;i<args.length;i++){if(args[i]==='--write')write=true;else if(['--project','--config','--state-dir','--codex'].includes(args[i]))values[args[i].slice(2)]=args[++i];else throw new Error('Usage: node scripts/install.mjs --project ABSOLUTE_PATH [--config MCP_CONFIG_JSON] [--state-dir PATH] [--codex PATH] [--write]');}
if(!values.project)throw new Error('--project is required');
const project=allowedDirectory(path.resolve(values.project),[await fs.realpath(path.resolve(values.project))]);
const filename=path.resolve(values.config||path.join(os.homedir(),'.gemini','config','mcp_config.json'));
const stateDir=path.resolve(values['state-dir']||path.join(os.homedir(),'.antigravity-codex'));
const server={command:process.execPath,args:[path.join(root,'bin','bridge.mjs'),'--state-dir',stateDir,'--allow-root',project,...(values.codex?['--codex',values.codex]:[])],cwd:project,timeoutSeconds:120};
let data={};try{const text=(await fs.readFile(filename,'utf8')).replace(/^\uFEFF/,'').trim();data=text?JSON.parse(text):{};}catch(error){if(error.code!=='ENOENT')throw error;}
if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('MCP config must be a JSON object');
data.mcpServers??={};if(typeof data.mcpServers!=='object'||Array.isArray(data.mcpServers))throw new Error('mcpServers must be a JSON object');data.mcpServers.codex=server;
if(write){await fs.mkdir(path.dirname(filename),{recursive:true});try{await fs.copyFile(filename,filename+'.backup-'+Date.now());}catch(error){if(error.code!=='ENOENT')throw error;}await fs.writeFile(filename,JSON.stringify(data,null,2)+'\n');console.log(`Configured codex MCP in ${filename}\nAllowed project: ${project}\nRestart/refresh the MCP server, then ask Antigravity to call codex_open.`);}
else console.log(JSON.stringify({config_file:filename,configuration:data},null,2));
