import { execSync, spawn } from 'child_process';
import os from 'os';

function isOllamaInPath(): boolean {
  try {
    execSync('ollama --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function isOllamaRunning(): boolean {
  try {
    const result = execSync('curl -s -o /dev/null -w "%{http_code}" http://localhost:11434/api/tags', {
      stdio: 'pipe',
    }).toString();
    return result === '200';
  } catch {
    return false;
  }
}

function installOllamaMac(): void {
  console.error('[aibrain] Installing Ollama on macOS...');
  const hasHomebrew = (() => {
    try {
      execSync('brew --version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  })();

  if (hasHomebrew) {
    console.error('[aibrain] Using Homebrew: brew install ollama');
    execSync('brew install ollama', { stdio: 'inherit' });
  } else {
    console.error('[aibrain] Homebrew not found. Downloading Ollama installer...');
    execSync(
      'curl -fsSL https://ollama.com/install.sh | sh',
      { stdio: 'inherit', shell: '/bin/bash' }
    );
  }
}

function installOllamaLinux(): void {
  console.error('[aibrain] Installing Ollama on Linux...');
  execSync('curl -fsSL https://ollama.com/install.sh | sh', {
    stdio: 'inherit',
    shell: '/bin/bash',
  });
}

function installOllamaWindows(): void {
  console.error('[aibrain] Please download and install Ollama from: https://ollama.com/download/windows');
  console.error('[aibrain] After installation, run: ollama pull nomic-embed-text');
}

export async function setupOllama(): Promise<void> {
  console.error('\n[aibrain] === Setup Mode ===\n');

  // Step 1: Check if Ollama is installed
  if (!isOllamaInPath()) {
    console.error('[aibrain] Ollama not found in PATH. Installing...');
    const platform = os.platform();

    if (platform === 'darwin') {
      installOllamaMac();
    } else if (platform === 'linux') {
      installOllamaLinux();
    } else if (platform === 'win32') {
      installOllamaWindows();
      return;
    } else {
      console.error(`[aibrain] Unsupported platform: ${platform}. Please install Ollama manually from https://ollama.com`);
      return;
    }
  } else {
    console.error('[aibrain] Ollama is already installed.');
  }

  // Step 2: Start Ollama if not running
  if (!isOllamaRunning()) {
    console.error('[aibrain] Starting Ollama server in background...');
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Give it a moment to start
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } else {
    console.error('[aibrain] Ollama server is already running.');
  }

  // Step 3: Pull the embedding model
  console.error('[aibrain] Pulling nomic-embed-text model (this may take a few minutes)...');
  try {
    execSync('ollama pull nomic-embed-text', { stdio: 'inherit' });
    console.error('[aibrain] Model ready!');
  } catch (err: any) {
    console.error('[aibrain] Warning: Could not pull model:', err.message);
  }

  console.error('\n[aibrain] Setup complete! Run aibrain-mcp to start the server.\n');
}

export function checkOllamaInstalled(): void {
  if (!isOllamaInPath()) {
    console.error(
      '[aibrain] Note: Ollama not found. Semantic search will be disabled.\n' +
      '[aibrain] Run: npx -y @aibrain/mcp --setup  to install Ollama automatically.'
    );
  }
}
