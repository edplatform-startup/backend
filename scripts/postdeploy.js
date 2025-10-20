#!/usr/bin/env node
/**
 * postdeploy.js
 * 
 * Safe post-deployment script that runs optional tooling like Prisma generate,
 * database migrations, etc. This runs AFTER npm install completes on Render.
 * 
 * We keep this separate from postinstall hooks to avoid hanging npm ci with
 * interactive prompts or slow operations that require DATABASE_URL.
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';

const HUSKY = '0';
const NPM_CONFIG_OPTIONAL = 'false';

console.log('[postdeploy] Starting post-deployment tasks...');

// Guard: Skip git hooks
process.env.HUSKY = HUSKY;
process.env.NPM_CONFIG_OPTIONAL = NPM_CONFIG_OPTIONAL;

/**
 * Run a command safely, logging output and catching errors
 */
function runCommand(command, description) {
  console.log(`[postdeploy] ${description}...`);
  try {
    execSync(command, { 
      stdio: 'inherit',
      env: { 
        ...process.env,
        HUSKY,
        NPM_CONFIG_OPTIONAL 
      }
    });
    console.log(`[postdeploy] ✓ ${description} completed`);
    return true;
  } catch (err) {
    console.error(`[postdeploy] ✗ ${description} failed:`, err.message);
    return false;
  }
}

/**
 * Check if Prisma is installed and DATABASE_URL is set
 */
function checkPrisma() {
  const hasPrisma = existsSync('./node_modules/.bin/prisma') || 
                    existsSync('./node_modules/prisma');
  const hasDatabaseUrl = !!process.env.DATABASE_URL;
  
  if (hasPrisma && hasDatabaseUrl) {
    console.log('[postdeploy] Prisma detected with DATABASE_URL');
    return runCommand('npx prisma generate', 'Generating Prisma Client');
  } else if (hasPrisma && !hasDatabaseUrl) {
    console.log('[postdeploy] ⚠ Prisma detected but DATABASE_URL not set - skipping generation');
  } else {
    console.log('[postdeploy] No Prisma detected - skipping');
  }
  return true;
}

/**
 * Main execution
 */
function main() {
  console.log('[postdeploy] Environment:', {
    NODE_ENV: process.env.NODE_ENV,
    CI: process.env.CI,
    HUSKY,
    NPM_CONFIG_OPTIONAL,
    hasDatabaseUrl: !!process.env.DATABASE_URL
  });

  // Run Prisma generation if applicable
  checkPrisma();

  // Add any other post-deployment tasks here
  // Example: database migrations, cache warming, etc.

  console.log('[postdeploy] ✓ All post-deployment tasks completed');
}

main();
