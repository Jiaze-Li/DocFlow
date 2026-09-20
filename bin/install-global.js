#!/usr/bin/env node
import { globalStatus, installGlobal } from '../src/install.js';

try {
  if (process.argv.includes('--status')) console.log(JSON.stringify(globalStatus(), null, 2));
  else {
    const result = installGlobal();
    const installed = Object.entries(result.present).filter(([, value]) => value).map(([name]) => name);
    console.log(`DocFlow installed globally for: ${installed.join(', ') || '(none)'}`);
    console.log(`CLI: ${result.cliPath}`);
    console.log('Restart/open a new agent session so each client reloads the DocFlow policy.');
  }
} catch (error) {
  console.error(`DocFlow global install failed: ${error.message}`);
  process.exitCode = 1;
}
