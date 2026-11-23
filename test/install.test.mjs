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
  const args=[installer,'--project',dir,'--config',filename,'--state-dir',path.join(dir,'state'),'--skill-dir',path.join(dir,'skills','codex-coordinator')];
  const dry=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});assert.equal(dry.status,0,dry.stderr);assert.equal(await fs.readFile(filename,'utf8'),before);
  await assert.rejects(fs.access(path.join(dir,'skills')));
  const write=spawnSync(process.execPath,[...args,'--write'],{encoding:'utf8',windowsHide:true});assert.equal(write.status,0,write.stderr);
  const after=JSON.parse(await fs.readFile(filename,'utf8'));assert.equal(after.mcpServers.existing.command,'fixture');assert.equal(after.customSetting,true);assert.ok(after.mcpServers.codex.args.includes(dir));
  const backup=(await fs.readdir(dir)).find(x=>x.startsWith('mcp.json.backup-'));assert.equal(await fs.readFile(path.join(dir,backup),'utf8'),before);
  assert.match(await fs.readFile(path.join(dir,'skills','codex-coordinator','SKILL.md'),'utf8'),/name: codex-coordinator/);
});

test('installer refuses unmanaged skills before changing configuration',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-install-foreign-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'mcp.json'),skill=path.join(dir,'skill');await fs.mkdir(skill);await fs.writeFile(path.join(skill,'SKILL.md'),'user-owned skill');await fs.writeFile(filename,'{}');
  const result=spawnSync(process.execPath,[installer,'--project',dir,'--config',filename,'--skill-dir',skill,'--write'],{encoding:'utf8',windowsHide:true});
  assert.notEqual(result.status,0);assert.match(result.stderr,/unmanaged/);assert.equal(await fs.readFile(filename,'utf8'),'{}');assert.equal(await fs.readFile(path.join(skill,'SKILL.md'),'utf8'),'user-owned skill');
});

test('managed skill upgrades preserve a backup outside active skill discovery',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-install-upgrade-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'mcp.json'),skill=path.join(dir,'skills','codex-coordinator'),state=path.join(dir,'state');
  const args=[installer,'--project',dir,'--config',filename,'--skill-dir',skill,'--state-dir',state,'--write'];
  let result=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
  await fs.appendFile(path.join(skill,'SKILL.md'),'\ncustom local note\n');
  result=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
  const backups=await fs.readdir(path.join(state,'installer-backups'));assert.equal(backups.length,1);
  assert.match(await fs.readFile(path.join(state,'installer-backups',backups[0],'SKILL.md'),'utf8'),/custom local note/);
  assert.doesNotMatch(await fs.readFile(path.join(skill,'SKILL.md'),'utf8'),/custom local note/);
  assert.deepEqual(await fs.readdir(path.dirname(skill)),['codex-coordinator']);
});

test('upgrade retains explicit Codex binary, state directory, allowed roots and server settings',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-install-settings-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'mcp.json'),state=path.join(dir,'existing-state'),binary=path.join(dir,'desktop-codex');
  const existing={command:'node',args:['old-bridge.mjs','--state-dir',state,'--allow-root',dir,'--codex',binary,'--request-timeout','45000'],timeoutSeconds:180,env:{CUSTOM_SETTING:'preserve'}};
  await fs.writeFile(filename,JSON.stringify({mcpServers:{codex:existing}}));
  const result=spawnSync(process.execPath,[installer,'--project',dir,'--config',filename,'--scope','project','--write'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
  const server=JSON.parse(await fs.readFile(filename,'utf8')).mcpServers.codex;
  assert.equal(server.args[server.args.indexOf('--codex')+1],binary);assert.equal(server.args[server.args.indexOf('--state-dir')+1],state);
  assert.equal(server.args[server.args.indexOf('--request-timeout')+1],'45000');assert.equal(server.timeoutSeconds,180);assert.equal(server.env.CUSTOM_SETTING,'preserve');
});
test('installer initializes an existing empty configuration',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-install-empty-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'mcp.json');await fs.writeFile(filename,'');
  const result=spawnSync(process.execPath,[installer,'--project',dir,'--config',filename,'--scope','project','--write'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);assert.ok(JSON.parse(await fs.readFile(filename,'utf8')).mcpServers.codex);
  assert.match(await fs.readFile(path.join(dir,'.agents','skills','codex-coordinator','SKILL.md'),'utf8'),/name: codex-coordinator/);
});
