import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const installer=fileURLToPath(new URL('../scripts/install.mjs',import.meta.url));
test('installer preserves other servers, creates a backup and leaves dry runs unchanged',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-install-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'mcp.json'),before=JSON.stringify({mcpServers:{existing:{command:'fixture'}},customSetting:true});await fs.writeFile(filename,before);
  const args=[installer,'--project',dir,'--config',filename,'--state-dir',path.join(dir,'state')];
  const dry=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});assert.equal(dry.status,0,dry.stderr);assert.equal(await fs.readFile(filename,'utf8'),before);
  const write=spawnSync(process.execPath,[...args,'--write'],{encoding:'utf8',windowsHide:true});assert.equal(write.status,0,write.stderr);
  const after=JSON.parse(await fs.readFile(filename,'utf8'));assert.equal(after.mcpServers.existing.command,'fixture');assert.equal(after.customSetting,true);assert.ok(after.mcpServers.codex.args.includes(dir));
  const backup=(await fs.readdir(dir)).find(x=>x.startsWith('mcp.json.backup-'));assert.equal(await fs.readFile(path.join(dir,backup),'utf8'),before);
});
test('installer initializes an existing empty configuration',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-install-empty-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'mcp.json');await fs.writeFile(filename,'');
  const result=spawnSync(process.execPath,[installer,'--project',dir,'--config',filename,'--write'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);assert.ok(JSON.parse(await fs.readFile(filename,'utf8')).mcpServers.codex);
});
