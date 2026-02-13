# Grog — Claude Code Skills

Grog adds four slash commands to Claude Code for working with GitHub issues and pull requests directly from your terminal.

## Skills

### `/grog-solve <issue-url>`

Fetches a GitHub issue, analyzes it, and starts implementing the fix immediately. Downloads image attachments, reads the codebase, writes the code, and commits. Can post a summary back to the issue when done.

### `/grog-review <pr-url>`

Fetches a pull request with the full diff, inline comments, and review history. Performs a thorough code review and can post the review directly on the PR.

### `/grog-explore <repo-or-project-url>`

Lists all open issues from a repository or GitHub Project, grouped by labels or status columns. Lets you pick issues and batch-process them one by one.

### `/grog-answer <issue-url>`

Posts a summary comment to a GitHub issue. Gathers context from your recent work, writes a markdown summary, and posts it directly on the issue. Use after solving or reviewing to share what was done.

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/turinglabsorg/grog.git
```

### 2. Run the installer

```bash
cd grog/skill
./install.sh
```

The installer will:
- Copy the grog tool to `~/.claude/tools/grog/`
- Install npm dependencies
- Ask for your GitHub Personal Access Token
- Create the four skill files in `~/.claude/skills/`

### 3. Create a GitHub token

You need a GitHub Personal Access Token (classic) to fetch issues and post comments.

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token (classic)**
3. Select scopes:
   - `repo` — for private repositories
   - `public_repo` — if you only need public repos
4. Copy the token and paste it when the installer asks

The token is stored locally in `~/.claude/tools/grog/.env` and never leaves your machine. All GitHub actions (comments, reviews, pushes) appear under your account.

### 4. Use it

Open any Claude Code session and type:

```
/grog-solve https://github.com/owner/repo/issues/123
/grog-review https://github.com/owner/repo/pull/456
/grog-explore https://github.com/owner/repo
/grog-answer https://github.com/owner/repo/issues/123
```

## How it works

The skills call a local Node.js script (`~/.claude/tools/grog/index.js`) that talks to the GitHub API using your token. The script fetches the issue/PR data, downloads image attachments, and prints everything to stdout. Claude Code reads the output and acts on it — analyzing the code, implementing fixes, or writing reviews.

Since it runs inside Claude Code, it has full access to your local filesystem, git, and any tools you've configured. The skills are just the entry point — Claude does the actual work.

## Files

```
~/.claude/tools/grog/          # The grog CLI tool
  index.js                     # Main script
  package.json                 # Dependencies
  .env                         # Your GitHub token (GH_TOKEN=ghp_...)

~/.claude/skills/grog-solve/   # Skill definitions (created by installer)
~/.claude/skills/grog-explore/
~/.claude/skills/grog-review/
~/.claude/skills/grog-answer/
```

## Updating

To update, pull the latest and re-run the installer:

```bash
cd grog/skill
git pull
./install.sh
```

Your token will be preserved — the installer asks before overwriting it.
