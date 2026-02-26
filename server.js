'use strict';

require('dotenv').config();

const express = require('express');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT             = process.env.PORT             || 3000;
const GITHUB_USERNAME  = process.env.GITHUB_USERNAME  || 'sameermotwani17-cell';
const CLAUDE_TIMEOUT   = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10); // 5 min
const WORKSPACE_DIR    = path.join(__dirname, 'workspace');

// ─── Boot banner ─────────────────────────────────────────────────────────────

const BANNER = `
╔════════════════════════════════════════════════════════════════╗
║  ██████╗ ███████╗████████╗██████╗  ██████╗                    ║
║  ██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██╔═══██╗                   ║
║  ██████╔╝█████╗     ██║   ██████╔╝██║   ██║                   ║
║  ██╔══██╗██╔══╝     ██║   ██╔══██╗██║   ██║                   ║
║  ██║  ██║███████╗   ██║   ██║  ██║╚██████╔╝                   ║
║  ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝                   ║
║         >> GITHUB AGENT v1.0 // POWERED BY CLAUDE CODE <<     ║
╚════════════════════════════════════════════════════════════════╝`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

/** Run a shell command; resolves with { stdout, stderr } or rejects on non-zero exit. */
async function sh(cmd, cwd, extraEnv = {}) {
  const { stdout, stderr } = await execAsync(cmd, {
    cwd,
    env: { ...process.env, ...extraEnv },
    maxBuffer: 50 * 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Run Claude Code CLI non-interactively via `spawn` so the prompt is passed
 * as a direct argument — no shell interpolation / injection risk.
 *
 * claude --dangerously-skip-permissions -p "<prompt>"
 */
function runClaude(prompt, cwd) {
  return new Promise((resolve, reject) => {
    log('CLAUDE', 'Spawning Claude Code CLI...');

    const proc = spawn(
      'claude',
      ['--dangerously-skip-permissions', '-p', prompt],
      {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude Code timed out after ${CLAUDE_TIMEOUT / 1000}s`));
    }, CLAUDE_TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Claude Code exited with code ${code}\n${stderr}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Ensure workspace directory exists. */
function ensureWorkspace() {
  if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    log('INIT', `Created workspace at ${WORKSPACE_DIR}`);
  }
}

// ─── Core agent logic ─────────────────────────────────────────────────────────

async function processRepo(repo, prompt) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN environment variable is not set.');

  // Sanitise the repo name — strip any accidental URL prefix
  const repoName = repo
    .replace(/^https?:\/\/[^/]+\/[^/]+\//, '') // strip full URL
    .replace(/\.git$/, '')                       // strip .git suffix
    .replace(/[^a-zA-Z0-9_\-.]/, '');           // strip unsafe chars (first hit only)

  const repoDir = path.join(WORKSPACE_DIR, repoName);
  // Embed token in the remote URL for authenticated pushes
  const remoteUrl = `https://${token}@github.com/${GITHUB_USERNAME}/${repoName}.git`;

  log('AGENT', `Target: ${GITHUB_USERNAME}/${repoName}`);
  log('AGENT', `Prompt: ${prompt}`);

  // ── 1. Clone or pull ──────────────────────────────────────────────────────
  if (!fs.existsSync(repoDir)) {
    log('GIT', `Cloning ${repoName}...`);
    await sh(`git clone "${remoteUrl}" "${repoDir}"`);
  } else {
    log('GIT', `Repo already local — pulling latest...`);
    // Make sure the remote uses the current token (token may have been rotated)
    await sh(`git remote set-url origin "${remoteUrl}"`, repoDir);
    await sh('git pull --rebase', repoDir);
  }

  // ── 2. Configure local git identity for the commit ───────────────────────
  await sh(`git config user.email "retro-agent@github-agent.local"`, repoDir);
  await sh(`git config user.name "Retro GitHub Agent"`, repoDir);

  // ── 3. Run Claude Code ────────────────────────────────────────────────────
  const { stdout: claudeOutput } = await runClaude(prompt, repoDir);
  log('CLAUDE', 'Claude Code finished.');

  // ── 4. Detect changes ─────────────────────────────────────────────────────
  const { stdout: gitStatus } = await sh('git status --porcelain', repoDir);
  if (!gitStatus) {
    log('GIT', 'No changes detected — nothing to commit.');
    return { committed: false, repoName, claudeOutput };
  }

  // ── 5. Commit & push ──────────────────────────────────────────────────────
  const shortPrompt = prompt.length > 72 ? prompt.slice(0, 69) + '...' : prompt;
  const commitMsg   = `retro-agent: ${shortPrompt}`;

  await sh('git add -A', repoDir);
  await sh(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, repoDir);
  await sh('git push origin HEAD', repoDir);

  log('GIT', `Changes pushed to ${GITHUB_USERNAME}/${repoName} successfully.`);
  return { committed: true, repoName, claudeOutput };
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

/**
 * POST /webhook
 *
 * Body (JSON):
 *   { "repo": "my-repo-name", "prompt": "Add a CONTRIBUTING.md file" }
 *
 * Response (JSON):
 *   { "status": "success"|"error", "committed": bool, "claudeOutput": "..." }
 */
app.post('/webhook', async (req, res) => {
  const { repo, prompt } = req.body || {};

  if (!repo || typeof repo !== 'string' || !repo.trim()) {
    return res.status(400).json({ status: 'error', error: 'Field "repo" is required.' });
  }
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ status: 'error', error: 'Field "prompt" is required.' });
  }

  log('WEBHOOK', `Received job — repo="${repo.trim()}" prompt="${prompt.trim().slice(0, 80)}"`);

  try {
    const result = await processRepo(repo.trim(), prompt.trim());
    return res.json({
      status:       'success',
      repo:         result.repoName,
      committed:    result.committed,
      claudeOutput: result.claudeOutput,
    });
  } catch (err) {
    log('ERROR', err.message || String(err));
    return res.status(500).json({
      status: 'error',
      repo:   repo.trim(),
      error:  err.message || String(err),
    });
  }
});

/** GET /health — liveness probe */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'retro-github-agent', uptime: process.uptime() });
});

// ─── Start ───────────────────────────────────────────────────────────────────

ensureWorkspace();

app.listen(PORT, () => {
  console.log(BANNER);
  console.log();
  log('BOOT', `Listening on port ${PORT}`);
  log('BOOT', `Workspace : ${WORKSPACE_DIR}`);
  log('BOOT', `GitHub user: ${GITHUB_USERNAME}`);
  log('BOOT', `Claude timeout: ${CLAUDE_TIMEOUT / 1000}s`);
  console.log();
});
