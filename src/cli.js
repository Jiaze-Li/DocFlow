import fs from 'node:fs';
import os from 'node:os';
import { beginRound, checkpoint, configureGlobal, gateStatus, initRepo, projectStatus, resolveRepoRoot, startTask, syncObsidian } from './core.js';
import { catchUpAll, catchUpRepo, installSyncAgent, registerRepo, uninstallSyncAgent } from './catchup.js';
import { doctor, formatDoctor } from './doctor.js';
import { globalStatus, installGlobal } from './install.js';
import { formatIngestSummary } from './github.js';
import { ingestPullRequest, ingestPush } from './ingest.js';
import { setupRepo } from './setup-repo.js';
import { formatValidationFailure, validateCommitMessage } from './validator.js';

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
  return `DocFlow\n\nCommands:\n  init --project <name> [--summary <text>] [--note <file>]\n  configure --vault <path> [--project-folder "02 Projects"]\n  start --id <id> --title <title> --task <description> [--current <text>] [--next <text>]\n  begin [--id <task-id>]\n  checkpoint [--id <task-id>] --current <text> [--next <text>] [--status <status>] [--outcome <text>]\n  gate [--json]\n  status [--json]\n  sync [--refresh] [--json]\n  catch-up                       refresh + project every registered repo (what the LaunchAgent runs)\n  install-sync-agent [--interval <seconds>]   write the macOS LaunchAgent (does not load it)\n  uninstall-sync-agent\n  validate-message (--file <path> | --message <text>)\n  setup-repo [--action-ref <ref>]\n  ingest-github --event-name <push|pull_request> --event-path <file>\n  ingest-push --ref <refs/heads/x> --before <sha> --after <sha>\n  doctor\n  install-global\n  global-status\n\nCommon: --cwd <repo-path>`;
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const [command = 'help', ...rest] = argv;
  const opts = parseOptions(rest);
  const cwd = opts.cwd || process.cwd();
  const homeDir = env.HOME || os.homedir();
  switch (command) {
    case 'init': {
      const result = initRepo({ cwd, projectName: opts.project, summary: opts.summary || '', obsidianNote: opts.note, homeDir });
      const sync = syncObsidian({ cwd: result.repoRoot, homeDir });
      registerRepo({ repoRoot: result.repoRoot, homeDir });
      print({ ...result, obsidian: sync }, Boolean(opts.json)); return 0;
    }
    case 'configure': {
      const result = configureGlobal({ homeDir, vault: opts.vault, projectFolder: opts['project-folder'] || '02 Projects' });
      print(result, Boolean(opts.json)); return 0;
    }
    case 'start': {
      const result = startTask({ cwd, id: opts.id, title: opts.title, task: opts.task, current: opts.current || '', next: opts.next || '', status: opts.status || 'In progress', homeDir });
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
    case 'sync': {
      const root = resolveRepoRoot(cwd);
      registerRepo({ repoRoot: root, homeDir });
      if (opts.refresh) {
        const r = catchUpRepo({ repoRoot: root, homeDir });
        print(r, Boolean(opts.json)); return r.error ? 1 : 0;
      }
      print(syncObsidian({ cwd, homeDir }), Boolean(opts.json)); return 0;
    }
    case 'catch-up': {
      const r = catchUpAll({ homeDir });
      print(r, true); return r.ok ? 0 : 1;
    }
    case 'install-sync-agent': {
      print(installSyncAgent({ homeDir, ...(opts.interval ? { intervalSeconds: opts.interval } : {}) }), true); return 0;
    }
    case 'uninstall-sync-agent': {
      print(uninstallSyncAgent({ homeDir }), true); return 0;
    }
    case 'validate-message': {
      const text = opts.file ? fs.readFileSync(opts.file, 'utf8') : opts.message;
      if (text == null || text === true) throw new Error('validate-message needs --file <path> or --message <text>');
      const verdict = validateCommitMessage(text);
      if (verdict.ok) { if (opts.json) print(verdict, true); return 0; }
      if (opts.json) print(verdict, true); else console.error(formatValidationFailure(verdict));
      return 1;
    }
    case 'setup-repo': {
      const setup = setupRepo({ cwd, homeDir, actionRef: opts['action-ref'] || undefined, activate: !opts['no-activate'] });
      registerRepo({ repoRoot: setup.repoRoot, homeDir });
      print(setup, true); return 0;
    }
    case 'ingest-push': {
      const result = ingestPush({
        cwd, ref: opts.ref, before: opts.before || null, after: opts.after,
        defaultBranch: opts['default-branch'] || null, homeDir,
      });
      print(result, true); return 0;
    }
    case 'ingest-github': {
      const payload = JSON.parse(fs.readFileSync(opts['event-path'] || env.GITHUB_EVENT_PATH, 'utf8'));
      const eventName = opts['event-name'] || env.GITHUB_EVENT_NAME;
      const defaultBranch = payload.repository?.default_branch || null;
      let result;
      if (eventName === 'push') {
        result = ingestPush({
          cwd, ref: payload.ref, before: payload.before, after: payload.after,
          deleted: Boolean(payload.deleted), defaultBranch, homeDir,
        });
      } else if (eventName === 'pull_request') {
        result = ingestPullRequest({ cwd, payload, defaultBranch, homeDir });
      } else {
        result = { skipped: true, reason: `Unsupported event: ${eventName}` };
      }
      for (const w of result.warnings || []) {
        const why = w.problems.map((p) => p.reason).join(' ').replace(/[\r\n%]/g, ' ');
        console.log(`::warning title=DocFlow commit message::${w.sha.slice(0, 7)} ${JSON.stringify(w.subject)}: ${why}`);
      }
      if (result.recovery && result.recovery.anchored === false) {
        console.log(`::warning title=DocFlow recovery::${String(result.recovery.note).replace(/[\r\n%]/g, ' ')}`);
      }
      if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${formatIngestSummary(result)}\n`);
      print(result, true); return 0;
    }
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
