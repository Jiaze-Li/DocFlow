import os from 'node:os';
import { beginRound, checkpoint, configureGlobal, gateStatus, initRepo, projectStatus, startTask, syncObsidian } from './core.js';
import { doctor, formatDoctor } from './doctor.js';
import { globalStatus, installGlobal } from './install.js';

function parseOptions(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (!item.startsWith('--')) { out._.push(item); continue; }
    const eq = item.indexOf('=');
    if (eq > 2) { out[item.slice(2, eq)] = item.slice(eq + 1); continue; }
    const key = item.slice(2);
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) out[key] = args[++i];
    else out[key] = true;
  }
  return out;
}

function print(value, json = false) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function help() {
  return `DocFlow v1\n\nCommands:\n  init --project <name> [--summary <text>] [--note <file>]\n  configure --vault <path> [--project-folder "02 Projects"]\n  start --id <id> --title <title> --task <description> [--current <text>] [--next <text>]\n  begin [--id <task-id>]\n  checkpoint [--id <task-id>] --current <text> [--next <text>] [--status <status>] [--outcome <text>]\n  gate [--json]\n  status [--json]\n  sync [--json]\n  doctor\n  install-global\n  global-status\n\nCommon: --cwd <repo-path>`;
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const [command = 'help', ...rest] = argv;
  const opts = parseOptions(rest);
  const cwd = opts.cwd || process.cwd();
  const homeDir = env.HOME || os.homedir();
  switch (command) {
    case 'init': {
      const result = initRepo({ cwd, projectName: opts.project, summary: opts.summary || '', obsidianNote: opts.note });
      const sync = syncObsidian({ cwd: result.repoRoot, homeDir });
      print({ ...result, obsidian: sync }, Boolean(opts.json)); return 0;
    }
    case 'configure': {
      const result = configureGlobal({ homeDir, vault: opts.vault, projectFolder: opts['project-folder'] || '02 Projects' });
      print(result, Boolean(opts.json)); return 0;
    }
    case 'start': {
      const result = startTask({ cwd, id: opts.id, title: opts.title, task: opts.task, current: opts.current || '', next: opts.next || '', status: opts.status || 'In progress' });
      const sync = syncObsidian({ cwd: result.repoRoot, homeDir, taskId: result.task.id });
      print({ task: result.task, obsidian: sync }, Boolean(opts.json)); return 0;
    }
    case 'begin': {
      print(beginRound({ cwd, id: opts.id }), Boolean(opts.json)); return 0;
    }
    case 'checkpoint': {
      const result = checkpoint({
        cwd, id: opts.id, current: opts.current, next: opts.next || '',
        status: opts.status, outcome: opts.outcome, homeDir,
      });
      print({ task: result.task, gate: gateStatus({ cwd: result.repoRoot }), obsidian: result.obsidian }, Boolean(opts.json)); return 0;
    }
    case 'gate': print(gateStatus({ cwd }), Boolean(opts.json)); return 0;
    case 'status': print(projectStatus({ cwd }), Boolean(opts.json)); return 0;
    case 'sync': print(syncObsidian({ cwd, homeDir }), Boolean(opts.json)); return 0;
    case 'doctor': {
      const result = doctor({ cwd, homeDir });
      if (opts.json) print(result, true); else console.log(formatDoctor(result));
      return result.ok ? 0 : 1;
    }
    case 'install-global': {
      print(installGlobal({ homeDir }), Boolean(opts.json)); return 0;
    }
    case 'global-status': {
      print(globalStatus({ homeDir }), true); return 0;
    }
    case 'help': case '--help': case '-h': console.log(help()); return 0;
    default: throw new Error(`Unknown DocFlow command: ${command}`);
  }
}
