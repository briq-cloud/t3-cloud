#!/usr/bin/env node
import { prepareBootstrapMigration } from '../runtime-bootstrap-migration.mjs';
if (process.argv.length !== 2) { process.stderr.write('No arguments accepted; use protected deployment configuration and fixed bootstrap-input directory\n'); process.exitCode = 1; }
else try { process.stdout.write(`${JSON.stringify(await prepareBootstrapMigration())}\n`); }
catch { process.stderr.write('Bootstrap migration preparation failed; preserve durable evidence\n'); process.exitCode = 1; }
