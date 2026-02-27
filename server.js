'use strict';

require('dotenv').config();

const express    = require('express');
const { exec }   = require('child_process');
const { promisify } = require('util');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');

const execAsync = promisify(exec);

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT            = process.env.PORT            || 3000;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'sameermotwani17-cell';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const WORKSPACE_DIR   = path.join(__dirname, 'workspace');

// ─── Boot banner ─────────────────────────────────────────────────────────────

const BANNER = `
╔════════════════════════════════════════════════════════════════╗
║  ██████╗ ███████╗████████╗██████╗  ██████╗                    ║
║  ██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██╔═══██╗                   ║
║  ██████╔╝█████╗     ██║   ██████╔╝██║   ██║                   ║
║  ██╔══██╗██╔══╝     ██║   ██╔══██╗██║   ██║                   ║
║  ██║  ██║███████╗   ██║   ██║  ██║╚██████╔╝                   ║
║  ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝                   ║
║      >> GITHUB AGENT v2.0 // POWERED BY ANTHROPIC API <<      ║
╚════════════════════════════════════════════════════════════════╝`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

async function sh(cmd, cwd, extraEnv = {}) {
  const { stdout, stderr } = await execAsync(cmd, {
    cwd,
    env: { ...process.env, ...extraEnv },
    maxBuffer: 50 * 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// ─── Get all files in repo directory ─────────────────────────────────────────

function getRepoFiles(repoDir) {
  const results = [];
  const ignore = new Set(['.git', 'node_modules', '.env']);

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const relativePath = path.relative(repoDir, fullPath);
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          results.push({ path: relativePath, content });
        } catch {
          // skip binary files
        }
      }
    }
  }

  walk(repoDir);
  return results;
}

// ─── Call Anthropic API directly ─────────────────────────────────────────────

async function callAnthropicAPI(systemPrompt, userPrompt) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not set.');

  const body = JSON.stringify({
    model: 'claude-opus-4-6',
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            const text = parsed.content?.[0]?.text || '';
            resolve(text);
          } catch (e) {
            reject(new Error('Failed to parse Anthropic response: ' + data));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Parse file operations from Claude's response ────────────────────────────

function parseFileOperations(response) {
  const operations = [];

  // Match <file path="...">content</file> blocks
  const fileRegex = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g;
  let match;
  while ((match = fileRegex.exec(response)) !== null) {
    operations.push({ type: 'write', path: match[1], content: match[2].trim() });
  }

  // Match <delete path="..."/> blocks
  const deleteRegex = /<delete\s+path="([^"]+)"\s*\/>/g;
  while ((match = deleteRegex.exec(response)) !== null) {
    operations.push({ type: 'delete', path: match[1] });
  }

  return operations;
}

// ─── Apply file operations to disk ───────────────────────────────────────────

function applyFileOperations(repoDir, operations) {
  for (const op of operations) {
    const fullPath = path.join(repoDir, op.path);
    const dir = path.dirname(fullPath);

    if (op.type === 'write') {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, op.content, 'utf8');
      log('FILE', `Written: ${op.path}`);
    } else if (op.type === 'delete') {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        log('FILE', `Deleted: ${op.path}`);
      }
    }
  }
  return operations.length;
}

// ─── Core agent logic ─────────────────────────────────────────────────────────

async function processRepo(repo, prompt) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');

  const repoName = repo
    .replace(/^https?:\/\/[^/]+\/[^/]+\//, '')
    .replace(/\.git$/, '');

  const repoDir   = path.join(WORKSPACE_DIR, repoName);
  const remoteUrl = `https://${token}@github.com/${GITHUB_USERNAME}/${repoName}.git`;

  log('AGENT', `Target: ${GITHUB_USERNAME}/${repoName}`);
  log('AGENT', `Prompt: ${prompt}`);

  // ── 1. Clone or pull ──────────────────────────────────────────────────────
  if (!fs.existsSync(repoDir)) {
    log('GIT', `Cloning ${repoName}...`);
    await sh(`git clone "${remoteUrl}" "${repoDir}"`);
  } else {
    log('GIT', 'Pulling latest...');
    await sh(`git remote set-url origin "${remoteUrl}"`, repoDir);
    await sh('git pull --rebase', repoDir);
  }

  await sh(`git config user.email "retro-agent@github-agent.local"`, repoDir);
  await sh(`git config user.name "Retro GitHub Agent"`, repoDir);

  // ── 2. Read existing files for context ───────────────────────────────────
  const existingFiles = getRepoFiles(repoDir);
  const fileContext = existingFiles.length > 0
    ? existingFiles.map(f => `<existing_file path="${f.path}">\n${f.content}\n</existing_file>`).join('\n')
    : '(empty repository)';

  // ── 3. Call Anthropic API ─────────────────────────────────────────────────
  log('API', 'Calling Anthropic API...');

  const systemPrompt = `You are an expert software engineer building code for a GitHub repository.
Your job is to create, modify, or delete files based on the user's request.

RESPONSE FORMAT — you must respond ONLY with file operations using these XML tags:

To create or update a file:
<file path="relative/path/to/file.ext">
file contents here
</file>

To delete a file:
<delete path="relative/path/to/file.ext"/>

Rules:
- Always use forward slashes in paths
- Never include .git or node_modules in paths
- Write complete file contents, never truncate
- Create all files needed to fulfill the request
- If creating a Node.js project, always include package.json
- Do not add any explanation outside the XML tags`;

  const userPrompt = `Repository: ${repoName}

Existing files:
${fileContext}

Task: ${prompt}`;

  const claudeResponse = await callAnthropicAPI(systemPrompt, userPrompt);
  log('API', 'Anthropic API responded.');

  // ── 4. Apply file operations ──────────────────────────────────────────────
  const operations = parseFileOperations(claudeResponse);
  if (operations.length === 0) {
    log('AGENT', 'No file operations found in response.');
    return { committed: false, repoName, claudeOutput: claudeResponse };
  }

  const count = applyFileOperations(repoDir, operations);
  log('AGENT', `Applied ${count} file operation(s).`);

  // ── 5. Commit & push ──────────────────────────────────────────────────────
  const { stdout: gitStatus } = await sh('git status --porcelain', repoDir);
  if (!gitStatus) {
    log('GIT', 'No changes to commit.');
    return { committed: false, repoName, claudeOutput: claudeResponse };
  }

  const shortPrompt = prompt.length > 72 ? prompt.slice(0, 69) + '...' : prompt;
  await sh('git add -A', repoDir);
  await sh(`git commit -m "retro-agent: ${shortPrompt.replace(/"/g, '\\"')}"`, repoDir);
  await sh('git push origin HEAD', repoDir);

  log('GIT', `Pushed ${count} file(s) to ${repoName}.`);
  return { committed: true, repoName, claudeOutput: claudeResponse };
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
  const { repo, prompt } = req.body || {};

  if (!repo?.trim()) return res.status(400).json({ status: 'error', error: '"repo" is required.' });
  if (!prompt?.trim()) return res.status(400).json({ status: 'error', error: '"prompt" is required.' });

  log('WEBHOOK', `repo="${repo.trim()}" prompt="${prompt.trim().slice(0, 80)}"`);

  try {
    const result = await processRepo(repo.trim(), prompt.trim());
    return res.json({ status: 'success', repo: result.repoName, committed: result.committed, claudeOutput: result.claudeOutput });
  } catch (err) {
    log('ERROR', err.message);
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'retro-github-agent', version: '2.0', uptime: process.uptime() });
});

// ─── Start ───────────────────────────────────────────────────────────────────

if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  log('INIT', `Created workspace at ${WORKSPACE_DIR}`);
}

app.listen(PORT, () => {
  console.log(BANNER);
  console.log();
  log('BOOT', `Listening on port ${PORT}`);
  log('BOOT', `Workspace : ${WORKSPACE_DIR}`);
  log('BOOT', `GitHub user: ${GITHUB_USERNAME}`);
  log('BOOT', `Anthropic API: ${ANTHROPIC_KEY ? 'configured ✓' : 'MISSING ✗'}`);
  console.log();
});
