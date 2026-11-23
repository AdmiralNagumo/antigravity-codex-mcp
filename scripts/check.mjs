import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
const files=[];
async function scan(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())await scan(p);else if(/\.(mjs|cjs)$/.test(p))files.push(p);}}
for(const dir of ['src','bin','scripts','test','extension']){try{await scan(dir);}catch(error){if(error.code!=='ENOENT')throw error;}}
for(const filename of files){const p=spawnSync(process.execPath,['--check',filename],{encoding:'utf8',windowsHide:true});if(p.status!==0)throw new Error(filename+': '+p.stderr);}
const html=await fs.readFile('ui/conversation.html','utf8');new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
for(const filename of ['package.json','plugin.json','mcp_config.json','extension/package.json']){try{JSON.parse(await fs.readFile(filename,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}}
console.log(`Syntax OK: ${files.length} JavaScript files, UI script, JSON manifests.`);
