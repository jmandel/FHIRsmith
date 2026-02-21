#!/usr/bin/env node
'use strict';

/**
 * Apply patches to node_modules packages and rebuild native addons.
 *
 * Patches are stored in the patches/ directory using the naming convention:
 *   <package-name>+<version>.patch
 *
 * After applying patches that modify C/C++ source, the native addon is rebuilt.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const patchesDir = path.join(__dirname, '..', 'patches');

if (!fs.existsSync(patchesDir)) {
  process.exit(0);
}

const patches = fs.readdirSync(patchesDir).filter(f => f.endsWith('.patch'));

for (const patchFile of patches) {
  const match = patchFile.match(/^(.+)\+(.+)\.patch$/);
  if (!match) continue;

  const packageName = match[1];
  const packageDir = path.join(__dirname, '..', 'node_modules', packageName);

  if (!fs.existsSync(packageDir)) {
    console.log(`Skipping patch for ${packageName}: package not installed`);
    continue;
  }

  const patchPath = path.join(patchesDir, patchFile);
  console.log(`Applying patch: ${patchFile}`);

  try {
    // Apply the patch from the package directory
    execSync(`patch -p1 --forward --no-backup-if-mismatch < "${patchPath}"`, {
      cwd: packageDir,
      stdio: 'pipe',
    });
    console.log(`  Patch applied successfully`);
  } catch (err) {
    // patch returns non-zero if already applied (which is fine)
    const output = (err.stdout || '').toString();
    if (output.includes('Reversed') || output.includes('already applied')) {
      console.log(`  Patch already applied`);
    } else {
      console.warn(`  Warning: patch may have partially applied: ${output}`);
    }
  }

  // Check if the patch modifies native source and rebuild if needed
  const patchContent = fs.readFileSync(patchPath, 'utf8');
  const hasNativeChanges = /\.(cpp|hpp|cc|h|c|gypi|gyp)\b/.test(patchContent);

  if (hasNativeChanges) {
    console.log(`  Rebuilding native addon for ${packageName}...`);
    try {
      execSync(`node-gyp rebuild --release`, {
        cwd: packageDir,
        stdio: 'pipe',
      });
      console.log(`  Native addon rebuilt successfully`);
    } catch (err) {
      const stderr = (err.stderr || '').toString().trim();
      console.error(`  Warning: native rebuild failed. ${stderr ? 'Error: ' + stderr.split('\n').pop() : ''}`);
      console.error(`  You may need to run: cd node_modules/${packageName} && node-gyp rebuild --release`);
    }
  }
}
