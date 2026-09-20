#!/usr/bin/env node
import { runCli } from '../src/cli.js';

try {
  const code = await runCli();
  if (code) process.exitCode = code;
} catch (error) {
  console.error(`DocFlow error: ${error.message}`);
  process.exitCode = 1;
}
