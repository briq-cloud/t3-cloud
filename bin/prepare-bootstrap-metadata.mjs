#!/usr/bin/env node
import { prepareBootstrapMetadata } from '../runtime-bootstrap-migration.mjs';
if (process.argv.length !== 2) { process.stderr.write('No arguments accepted; use protected deployment configuration and fixed bootstrap-image-input directory\n'); process.exitCode = 1; }
else try { process.stdout.write(`${JSON.stringify(await prepareBootstrapMetadata())}\n`); }
catch { process.stderr.write('Bootstrap metadata preparation failed; preserve durable evidence\n'); process.exitCode = 1; }
