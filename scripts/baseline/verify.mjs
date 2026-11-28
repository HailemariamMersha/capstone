#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { verifyEvidence } from './evidence.mjs';

try {
  const { values } = parseArgs({
    options: { input: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help || !values.input) {
    console.log(
      'Usage: npm run baseline:verify -- --input EVIDENCE_FOLDER (run, comparison or supervisor bundle)',
    );
    if (!values.help) process.exitCode = 1;
  } else {
    const result = await verifyEvidence(values.input);
    console.log(
      result.ok
        ? `Verified all ${result.files} evidence files.`
        : JSON.stringify(result, null, 2),
    );
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(
    `Could not verify evidence: ${error.message}. A missing manifest indicates an unfinished or historical run.`,
  );
  process.exitCode = 1;
}
