import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './core.js';

export const POLICY_BEGIN = '<!-- DOCFLOW-GLOBAL-POLICY:BEGIN -->';
export const POLICY_END = '<!-- DOCFLOW-GLOBAL-POLICY:END -->';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const POLICY_FILE = path.join(ROOT, 'agent-policy', 'COMMON.md');
const DEFAULT_CLI = path.join(ROOT, 'bin', 'docflow.js');

function run(command, args, exec = execFileSync, allowFailure = false) {
  try {
    return String(exec(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) ?? '').trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function frontendAvailable(command, exec = execFileSync) {
  return run(command, ['--version'], exec, true) !== null;
}

export function resolveAgyConfigDir(env = process.env, homeDir = os.homedir()) {
  return env.ANTIGRAVITY_CONFIG_DIR || env.GEMINI_CONFIG_DIR || path.join(homeDir, '.gemini', 'config');
}

function renderPolicy(cliPath) {
  const template = fs.readFileSync(POLICY_FILE, 'utf8').trim();
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve(cliPath))}`;
  return template.replaceAll('{{DOCFLOW_CLI}}', command);
}

function replaceManaged(text, content) {
  const raw = String(text ?? '');
  const starts = raw.split(POLICY_BEGIN).length - 1;
  const ends = raw.split(POLICY_END).length - 1;
  if (starts > 1 || ends > 1 || starts !== ends) throw new Error('Refusing to modify malformed DocFlow policy block');
  const block = `${POLICY_BEGIN}\n${content.trim()}\n${POLICY_END}`;
  if (!starts) return `${raw.trimEnd()}${raw.trim() ? '\n\n' : ''}${block}\n`;
  const s = raw.indexOf(POLICY_BEGIN);
  const e = raw.indexOf(POLICY_END) + POLICY_END.length;
  return `${raw.slice(0, s)}${block}${raw.slice(e)}`.replace(/\s*$/, '\n');
}

function policyMatches(file, expected) {
  if (!fs.existsSync(file)) return false;
  const raw = fs.readFileSync(file, 'utf8');
  const s = raw.indexOf(POLICY_BEGIN);
  const e = raw.indexOf(POLICY_END);
  if (s < 0 || e < s) return false;
  return raw.slice(s + POLICY_BEGIN.length, e).trim() === expected.trim();
}

export function installGlobal({
  homeDir = os.homedir(), cliPath = DEFAULT_CLI, configDir, exec = execFileSync, present,
} = {}) {
  const detected = present ?? {
    claude: frontendAvailable('claude', exec),
    codex: frontendAvailable('codex', exec),
    agy: frontendAvailable('agy', exec),
  };
  if (!detected.claude && !detected.codex && !detected.agy) throw new Error('No supported coding agent (claude / codex / agy) found');
  const policy = renderPolicy(cliPath);
  const files = {
    claude: path.join(homeDir, '.claude', 'CLAUDE.md'),
    codex: path.join(homeDir, '.codex', 'AGENTS.md'),
    agy: path.join(homeDir, '.gemini', 'GEMINI.md'),
  };
  for (const name of Object.keys(files)) {
    if (!detected[name]) continue;
    const file = files[name];
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    atomicWrite(file, replaceManaged(existing, policy));
  }
  let skillFile = null;
  if (detected.agy) {
    const dir = configDir ?? resolveAgyConfigDir(process.env, homeDir);
    skillFile = path.join(dir, 'skills', 'docflow', 'SKILL.md');
    atomicWrite(skillFile, `---\nname: docflow\ndescription: Shared DocFlow development-documentation workflow.\n---\n\n${policy}\n`);
  }
  return { present: detected, cliPath: path.resolve(cliPath), policyFiles: files, skillFile };
}

export function globalStatus({ homeDir = os.homedir(), cliPath = DEFAULT_CLI, configDir, exec = execFileSync, present } = {}) {
  const detected = present ?? {
    claude: frontendAvailable('claude', exec),
    codex: frontendAvailable('codex', exec),
    agy: frontendAvailable('agy', exec),
  };
  const expected = renderPolicy(cliPath);
  const files = {
    claude: path.join(homeDir, '.claude', 'CLAUDE.md'),
    codex: path.join(homeDir, '.codex', 'AGENTS.md'),
    agy: path.join(homeDir, '.gemini', 'GEMINI.md'),
  };
  const out = {};
  for (const name of Object.keys(files)) {
    out[name] = { available: Boolean(detected[name]), installed: Boolean(detected[name]) && policyMatches(files[name], expected), file: files[name] };
  }
  const skillFile = path.join(configDir ?? resolveAgyConfigDir(process.env, homeDir), 'skills', 'docflow', 'SKILL.md');
  out.agy.skillInstalled = !out.agy.available ? false : fs.existsSync(skillFile);
  return out;
}
