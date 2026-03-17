import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
const REPO_URL = 'https://github.com/nkamau12/aibrain-ui.git';

function getParentDir(): string {
  // Use the user's current working directory so `npx @aibrain/mcp --setup-ui`
  // clones aibrain-ui next to wherever the user runs the command.
  return process.cwd();
}

function isGitInstalled(): boolean {
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function isNodeVersionOk(): boolean {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  return major >= 18;
}

export async function setupUI(targetDir?: string): Promise<void> {
  console.error('\n[aibrain] === Web Dashboard Setup ===\n');

  if (!isGitInstalled()) {
    console.error('[aibrain] Error: git is not installed. Please install git first.');
    return;
  }

  if (!isNodeVersionOk()) {
    console.error('[aibrain] Error: Node.js 18+ is required. Current:', process.version);
    return;
  }

  const parentDir = targetDir ? resolve(targetDir) : getParentDir();
  const uiDir = resolve(parentDir, 'aibrain-ui');

  if (existsSync(uiDir)) {
    console.error(`[aibrain] aibrain-ui already exists at ${uiDir}`);
    console.error('[aibrain] Pulling latest changes...');
    try {
      execSync('git pull', { cwd: uiDir, stdio: 'inherit' });
    } catch {
      console.error('[aibrain] Warning: git pull failed — continuing with existing code.');
    }
  } else {
    console.error(`[aibrain] Cloning aibrain-ui into ${uiDir}...`);
    try {
      execSync(`git clone ${REPO_URL}`, { cwd: parentDir, stdio: 'inherit' });
    } catch (err: any) {
      console.error('[aibrain] Error: Failed to clone aibrain-ui:', err.message);
      console.error(`[aibrain] You can clone it manually: git clone ${REPO_URL} ${uiDir}`);
      return;
    }
  }

  console.error('[aibrain] Installing dependencies...');
  try {
    execSync('npm install', { cwd: uiDir, stdio: 'inherit' });
  } catch (err: any) {
    console.error('[aibrain] Error: npm install failed:', err.message);
    return;
  }

  // Create .env if it doesn't exist
  const envFile = resolve(uiDir, '.env');
  if (!existsSync(envFile)) {
    const envExample = resolve(uiDir, '.env.example');
    if (existsSync(envExample)) {
      const { copyFileSync } = await import('fs');
      copyFileSync(envExample, envFile);
      console.error('[aibrain] Created .env from .env.example');
    }
  }

  console.error('\n[aibrain] === aibrain-ui setup complete! ===');
  console.error(`[aibrain] Location: ${uiDir}`);
  console.error('[aibrain] To start the dashboard:\n');
  console.error(`  cd ${uiDir}`);
  console.error('  npm run dev\n');
  console.error('[aibrain] Frontend: http://localhost:5173');
  console.error('[aibrain] API:      http://localhost:3001\n');
}
