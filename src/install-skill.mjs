import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VERSION } from './version.mjs';

const manifestName = '.codex-bridge-managed.json';
export async function prepareSkill(bundleRoot, destination) {
  const source = path.join(bundleRoot, 'skills', 'codex-coordinator');
  const target = path.resolve(destination), files = [];
  if (target === path.parse(target).root || bundleRoot === target || bundleRoot.startsWith(target + path.sep)) throw new Error('Skill destination must be a dedicated skill directory');
  async function collect(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) await collect(path.join(dir, entry.name), relative);
      else if (entry.isFile()) files.push({ path: relative, content: await fs.readFile(path.join(dir, entry.name), 'utf8') });
      else throw new Error('Skill bundle must contain regular files and directories');
    }
  }
  await collect(source);
  if (!files.some(f => f.path === 'SKILL.md')) throw new Error('Coordination skill is missing SKILL.md');
  let exists = false;
  try {
    const stat = await fs.lstat(target); exists = true;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill destination is not a regular directory');
    const managed = JSON.parse(await fs.readFile(path.join(target, manifestName), 'utf8'));
    if (managed.owner !== 'antigravity-codex-mcp') throw new Error('Unmanaged skill directory');
  } catch (error) {
    if (exists || error.code !== 'ENOENT') throw new Error(`Refusing to replace an unmanaged skill: ${target}. Select another --skill-dir. ${error.message}`);
  }
  return { target, exists, files };
}

export async function installConfiguration(filename, configuration, skill, backupRoot) {
  const suffix = Date.now() + '-' + randomUUID().slice(0,8);
  const skillBackup = path.join(backupRoot || path.join(path.dirname(filename), '.codex-bridge-backups'), 'codex-coordinator-' + suffix);
  const rollback = skill.target + '.rollback-' + suffix;
  const configBackup = filename + '.backup-' + suffix;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.mkdir(path.dirname(skill.target), { recursive: true });
  const stage = await fs.mkdtemp(path.join(path.dirname(skill.target), '.codex-coordinator-stage-'));
  const configTemp = filename + '.tmp-' + suffix;
  let movedOld = false, installedNew = false;
  try {
    for (const file of skill.files) {
      const dest = path.join(stage, file.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.content);
    }
    await fs.writeFile(path.join(stage, manifestName), JSON.stringify({ owner: 'antigravity-codex-mcp', version: VERSION }, null, 2) + '\n');
    await fs.writeFile(configTemp, JSON.stringify(configuration, null, 2) + '\n', { mode: 0o600 });
    try { await fs.copyFile(filename, configBackup); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (skill.exists) {
      // Backup storage may be on another Windows drive. Keep rollback renames
      // on the target volume and copy the durable backup across volumes.
      await fs.mkdir(path.dirname(skillBackup), { recursive: true });
      await fs.cp(skill.target, skillBackup, { recursive: true, errorOnExist: true, force: false });
      await fs.rename(skill.target, rollback); movedOld = true;
    }
    else {
      try { await fs.lstat(skill.target); throw new Error('Skill destination appeared during installation; retry after inspecting it'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.rename(stage, skill.target); installedNew = true;
    await fs.rename(configTemp, filename);
    if (movedOld) await fs.rm(rollback, { recursive: true });
    return { config_file: filename, skill_directory: skill.target, previous_skill_backup: movedOld ? skillBackup : null };
  } catch (error) {
    if (installedNew) await fs.rm(skill.target, { recursive: true, force: true });
    if (movedOld) await fs.rename(rollback, skill.target);
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(configTemp, { force: true });
  }
}
