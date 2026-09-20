#!/usr/bin/env node
import os from 'node:os';
import { configureGlobal } from '../src/core.js';
import { doctor, formatDoctor } from '../src/doctor.js';
import { installGlobal } from '../src/install.js';

function option(name) {
  const prefix = `--${name}=`;
  const direct = process.argv.find((x) => x.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

try {
  const homeDir = process.env.HOME || os.homedir();
  const vault = option('vault');
  if (vault) configureGlobal({ homeDir, vault, projectFolder: option('project-folder') || '02 Projects' });
  const installed = installGlobal({ homeDir });
  console.log(`DocFlow installed globally for: ${Object.entries(installed.present).filter(([, v]) => v).map(([k]) => k).join(', ')}`);
  const result = doctor({ homeDir });
  console.log(formatDoctor(result));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(`DocFlow setup failed: ${error.message}`);
  process.exitCode = 1;
}
