#!/usr/bin/env node
import { packBundle } from '../runtime-bundle.mjs';

const [root, output, baseImage, source, childImage] = process.argv.slice(2);
if (!root || !output || !baseImage || !source || !childImage || process.argv.length !== 7) {
  process.stderr.write('Usage: pack-runtime-bundle <image-root> <output> <base-image-digest> <source-commit> <child-image-digest>\n');
  process.exitCode = 2;
} else {
  try {
    await packBundle(root, output, { baseImage, source, childImage });
  } catch {
    process.stderr.write('Release bundle packing failed\n');
    process.exitCode = 1;
  }
}
