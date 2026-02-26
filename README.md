```
╔════════════════════════════════════════════════════════════════╗
║  ██████╗ ███████╗████████╗██████╗  ██████╗                    ║
║  ██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██╔═══██╗                   ║
║  ██████╔╝█████╗     ██║   ██████╔╝██║   ██║                   ║
║  ██╔══██╗██╔══╝     ██║   ██╔══██╗██║   ██║                   ║
║  ██║  ██║███████╗   ██║   ██║  ██║╚██████╔╝                   ║
║  ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝                   ║
║       >> GITHUB AGENT v1.0 // POWERED BY CLAUDE CODE <<       ║
╚════════════════════════════════════════════════════════════════╝
```

# Retro GitHub Agent

A retro-themed autonomous GitHub agent. Send a plain-English instruction to an **n8n webhook**, and the agent will **clone the target repo**, run **Claude Code CLI** against it, then **commit and push the results** back to GitHub — fully automated.

---

## How it works

```
n8n Workflow
    │
    │  POST /webhook
    │  { "repo": "my-repo", "prompt": "Add a LICENSE file" }
    ▼
Express Server (server.js)
    │
    ├─► git clone  (or git pull if already local)
    │
    ├─► claude --dangerously-skip-permissions -p "<prompt>"
    │       Claude Code reads the repo, makes changes
    │
    ├─► git add -A  &&  git commit  &&  git push
    │
    └─► JSON response back to n8n
            { "status": "success", "committed": true, "claudeOutput": "..." }
```

---

## Prerequisites

| Tool | Notes |
|------|-------|
| **Node.js ≥ 18** | Runs the Express server |
| **Git** | Must be on `PATH` |
| **Claude Code CLI** | Install: `npm install -g @anthropic-ai/claude-code` |
| **GitHub Personal Access Token** | Needs `repo` (read + write) scope |

---

## Setup

### 1. Clone this repo

```bash
git clone https://github.com/sameermotwani17-cell/retro_github-agent.git
cd retro_github-agent
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set your GitHub token:

```env
GITHUB_TOKEN=ghp_your_personal_access_token
GITHUB_USERNAME=sameermotwani17-cell
PORT=3000
CLAUDE_TIMEOUT_MS=300000
```

### 4. Start the server

```bash
npm start          # production
npm run dev        # development (auto-restart with nodemon)
```

You should see:

```
╔════════════════════════════════════════════════════════════════╗
║  ██████╗ ███████╗████████╗██████╗  ██████╗                    ║
...
[BOOT] Listening on port 3000
[BOOT] Workspace : /path/to/retro_github-agent/workspace
```

---

## API

### `POST /webhook`

Trigger the agent.

**Request body** (JSON):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo` | string | yes | Repository name (e.g. `my-project`) — owner is always `GITHUB_USERNAME` |
| `prompt` | string | yes | Plain-English instruction for Claude Code |

**Example:**

```json
{
  "repo": "my-project",
  "prompt": "Refactor the main function to use async/await and add JSDoc comments"
}
```

**Success response:**

```json
{
  "status": "success",
  "repo": "my-project",
  "committed": true,
  "claudeOutput": "I've refactored the main function..."
}
```

**Error response:**

```json
{
  "status": "error",
  "repo": "my-project",
  "error": "GITHUB_TOKEN environment variable is not set."
}
```

---

### `GET /health`

Liveness check.

```json
{ "status": "ok", "agent": "retro-github-agent", "uptime": 42.1 }
```

---

## n8n Integration

1. Create a new **n8n workflow**.
2. Add an **HTTP Request** node (or trigger via a Schedule / Manual node upstream).
3. Set:
   - **Method:** `POST`
   - **URL:** `http://your-server:3000/webhook`
   - **Body:** JSON with `repo` and `prompt` fields.
4. Wire the response into downstream nodes as needed.

> **Tip:** n8n's default HTTP Request timeout is 5 minutes. If your Claude Code jobs run longer, increase `CLAUDE_TIMEOUT_MS` on the agent side and configure n8n's timeout to match.

---

## Project structure

```
retro_github-agent/
├── server.js          ← Express server + agent logic
├── package.json
├── .env.example       ← Copy to .env and fill in secrets
├── .gitignore
├── README.md
└── workspace/         ← Cloned repos live here (git-ignored)
```

---

## Security notes

- The `GITHUB_TOKEN` is embedded in the git remote URL for authentication. It is **never logged** (the URL is only used internally).
- `--dangerously-skip-permissions` is required for non-interactive Claude Code use. Only run this agent in a trusted, isolated environment.
- The `workspace/` directory is git-ignored — cloned repos and their secrets are never committed to this repo.

---

## License

MIT
