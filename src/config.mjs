import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

export function options(argv = process.argv.slice(2), env = process.env) {
  const config = {
    mode: 'mcp',
    stateDir: env.CODEX_BRIDGE_STATE_DIR || path.join(os.homedir(), '.antigravity-codex'),
    command: env.CODEX_BRIDGE_CODEX || 'codex',
    commandArgs: JSON.parse(env.CODEX_BRIDGE_CODEX_ARGS || '[]'),
    roots: env.CODEX_BRIDGE_ROOTS ? JSON.parse(env.CODEX_BRIDGE_ROOTS) : [],
    requestTimeout: 30000,
  };
  const flags = { '--state-dir': 'stateDir', '--codex': 'command', '--request-timeout': 'requestTimeout' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['mcp', 'daemon', 'doctor', 'stop'].includes(flag)) config.mode = flag;
    else if (flag === '--allow-root') config.roots.push(argv[++i]);
    else if (flag === '--codex-arg') config.commandArgs.push(argv[++i]);
    else if (flags[flag]) config[flags[flag]] = argv[++i];
    else if (flag === '--help' || flag === '-h') config.mode = 'help';
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!config.roots.length) config.roots.push(process.cwd());
  if (!Array.isArray(config.commandArgs) || !config.commandArgs.every(x => typeof x === 'string')) throw new Error('CODEX_BRIDGE_CODEX_ARGS must be a JSON string array');
  if (!Array.isArray(config.roots) || !config.roots.every(x => typeof x === 'string' && x)) throw new Error('Allowed roots must be a JSON string array');
  config.roots = [...new Set(config.roots.map(p => fs.realpathSync(path.resolve(p))))];
  config.stateDir = path.resolve(config.stateDir);
  config.requestTimeout = Number(config.requestTimeout);
  if (!Number.isInteger(config.requestTimeout) || config.requestTimeout < 100) throw new Error('Invalid request timeout');
  return config;
}

export function allowedDirectory(cwd, roots) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute project directory');
  const resolved = fs.realpathSync(cwd);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('cwd must be a directory');
  if (!roots.some(root => {
    const rel = path.relative(root, resolved);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  })) throw new Error(`Project is outside the configured allowed roots: ${resolved}`);
  return resolved;
}

// Spawn actual programs without shell interpolation. npm's Windows .cmd shim is
// replaced with node + its known JS entrypoint, not passed through cmd.exe.
export function resolveCommand(command, args = [], env = process.env) {
  if (/\.cmd$/i.test(command) || (process.platform === 'win32' && !path.extname(command))) {
    const dirs = path.dirname(command) !== '.' ? [path.dirname(command)] : (env.PATH || '').split(path.delimiter);
    for (const dir of dirs) {
      const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (['codex', 'codex.cmd'].includes(path.basename(command).toLowerCase()) && fs.existsSync(entry)) {
        try {
          const require = createRequire(entry);
          const platform = process.arch === 'arm64' ? 'arm64' : 'x64';
          const pkg = require.resolve(`@openai/codex-win32-${platform}/package.json`);
          const triple = platform === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
          const binary = path.join(path.dirname(pkg), 'vendor', triple, 'bin', 'codex.exe');
          if (fs.existsSync(binary)) return { command: binary, args };
        } catch { /* Older npm layouts use the JS launcher. */ }
        return { command: process.execPath, args: [entry, ...args] };
      }
    }
    if (/\.cmd$/i.test(command)) throw new Error('Use a Codex executable or node + codex.js; arbitrary .cmd shims are not supported');
  }
  return { command, args };
}
