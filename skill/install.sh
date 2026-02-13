#!/bin/bash

# GROG Installer
# Installs grog to ~/.claude/tools/grog and creates the Claude Code skills

set -e

# Terminal style - no colors, monospace aesthetic
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

echo ""
echo "┌──────────────────────────────────────────┐"
echo "│                                          │"
echo "│   ██████  ██████   ██████   ██████       │"
echo "│  ██       ██   ██ ██    ██ ██            │"
echo "│  ██   ███ ██████  ██    ██ ██   ███      │"
echo "│  ██    ██ ██   ██ ██    ██ ██    ██      │"
echo "│   ██████  ██   ██  ██████   ██████       │"
echo "│                                          │"
echo "│   github issue fetcher for claude code   │"
echo "│                                          │"
echo "└──────────────────────────────────────────┘"
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Target directories
TOOLS_DIR="$HOME/.claude/tools/grog"
SKILLS_DIR="$HOME/.claude/skills"

echo -e "${BOLD}[1/5]${NC} creating directories..."
mkdir -p "$TOOLS_DIR"
mkdir -p "$SKILLS_DIR/grog-solve"
mkdir -p "$SKILLS_DIR/grog-explore"
mkdir -p "$SKILLS_DIR/grog-review"
mkdir -p "$SKILLS_DIR/grog-answer"
# Remove old /grog skill if it exists
rm -rf "$SKILLS_DIR/grog" 2>/dev/null || true
echo "  > $TOOLS_DIR"
echo "  > skill directories"

echo ""
echo -e "${BOLD}[2/5]${NC} copying files..."
cp "$SCRIPT_DIR/index.js" "$TOOLS_DIR/"
cp "$SCRIPT_DIR/package.json" "$TOOLS_DIR/"
echo "  > index.js and package.json"

echo ""
echo -e "${BOLD}[3/5]${NC} installing dependencies..."
cd "$TOOLS_DIR"
npm install --silent
echo "  > dependencies installed"

echo ""
echo -e "${BOLD}[4/5]${NC} configuring GitHub token..."
echo ""
echo "To fetch GitHub issues, grog needs a Personal Access Token."
echo "You can create one at: https://github.com/settings/tokens"
echo "Required scope: repo (for private repos) or public_repo (for public only)"
echo ""

# Check if token already exists
if [ -f "$TOOLS_DIR/.env" ] && grep -q "GH_TOKEN=" "$TOOLS_DIR/.env"; then
    echo "  a token already exists in $TOOLS_DIR/.env"
    read -p "  replace it? (y/N): " REPLACE_TOKEN
    if [[ ! "$REPLACE_TOKEN" =~ ^[Yy]$ ]]; then
        echo "  > keeping existing token"
        SKIP_TOKEN=true
    fi
fi

if [ "$SKIP_TOKEN" != "true" ]; then
    read -p "Enter your GitHub token (ghp_...): " GH_TOKEN

    if [ -z "$GH_TOKEN" ]; then
        echo "  ! no token provided. add it manually to $TOOLS_DIR/.env"
        echo "GH_TOKEN=" > "$TOOLS_DIR/.env"
    else
        echo "GH_TOKEN=$GH_TOKEN" > "$TOOLS_DIR/.env"
        chmod 600 "$TOOLS_DIR/.env"
        echo "  > token saved to $TOOLS_DIR/.env"
    fi
fi

echo ""
echo -e "${BOLD}[5/5]${NC} creating Claude Code skills..."

# Skill 1: /grog-solve - Fetch and solve a single issue
cat > "$SKILLS_DIR/grog-solve/SKILL.md" << 'EOF'
---
name: grog-solve
description: Fetch and solve a GitHub issue. Use when the user provides a GitHub issue URL or asks to solve/fix/implement a GitHub issue.
allowed-tools: Bash, Read
argument-hint: <github-issue-url>
---

# GROG Solve - GitHub Issue Solver

Fetch a GitHub issue and immediately start solving it.

## Usage

When the user provides a GitHub issue URL (like `https://github.com/owner/repo/issues/123`), run:

```bash
node ~/.claude/tools/grog/index.js solve $ARGUMENTS
```

The tool automatically downloads any image attachments to `/tmp/grog-attachments/`.

## IMPORTANT: Analyze Image Attachments

If the output shows "IMAGE ATTACHMENTS" with file paths, you MUST use the Read tool to view each image file. These screenshots/mockups are critical for understanding the issue. Do this immediately after running grog, before doing anything else.

## What to do with the output

1. Run grog solve to fetch the issue
2. If image paths are shown, use Read tool on EACH image file to view them
3. Briefly summarize the issue (title, state, key labels) including what the images show
4. Analyze the codebase to understand how to implement the requested feature or fix
5. Create a concrete implementation plan with specific files to modify/create
6. Start implementing the solution immediately - don't ask for permission, just do it
7. If you need to make architectural decisions, pick the simplest approach that fits the existing codebase patterns

Be proactive: your goal is to solve the issue, not just report on it.

## Error Handling

- If no URL is provided, ask the user for the GitHub issue URL
- If the token is missing, inform the user to run the install script again or manually add GH_TOKEN to `~/.claude/tools/grog/.env`
EOF

echo "  > /grog-solve skill"

# Skill 2: /grog-explore - Explore a project's issues for batch processing
cat > "$SKILLS_DIR/grog-explore/SKILL.md" << 'EOF'
---
name: grog-explore
description: Explore a GitHub repository's issues for batch processing. Use when the user provides a GitHub repo URL and wants to work through multiple issues.
allowed-tools: Bash, Read
argument-hint: <github-project-url>
---

# GROG Explore - GitHub Project Issue Explorer

List all issues from a GitHub Project or repository for batch processing.

## Usage

Supports both GitHub Projects and repositories:

```bash
# For GitHub Projects (recommended for multi-repo workflows)
node ~/.claude/tools/grog/index.js explore https://github.com/orgs/orgname/projects/1

# For a single repository
node ~/.claude/tools/grog/index.js explore https://github.com/owner/repo
```

## Supported URL formats

- **Org Project**: `https://github.com/orgs/orgname/projects/123`
- **User Project**: `https://github.com/users/username/projects/123`
- **Repository**: `https://github.com/owner/repo`

## Workflow

1. Run grog explore to fetch all issues
2. For Projects: issues are grouped by status (Todo, In Progress, Done, etc.)
3. For Repos: issues are grouped by labels
4. Ask the user which issues they want to work on:
   - A status name (e.g., "Todo", "In Progress") for projects
   - A label name (e.g., "bug", "enhancement") for repos
   - Specific issue references (e.g., "#123, #456")
   - "all" to work on all issues
5. Once the user selects, process each issue one by one:
   - Use `/grog-solve <issue-url>` to fetch the full issue details
   - Implement the solution
   - Commit the changes with a descriptive message
   - Move to the next issue

## Error Handling

- If no URL is provided, ask the user for the GitHub project or repository URL
- If the token is missing, inform the user to run the install script again or manually add GH_TOKEN to `~/.claude/tools/grog/.env`
EOF

echo "  > /grog-explore skill"

# Skill 3: /grog-review - Review a pull request
cat > "$SKILLS_DIR/grog-review/SKILL.md" << 'EOF'
---
name: grog-review
description: Review a GitHub pull request. Use when the user provides a GitHub PR URL or asks to review a pull request.
allowed-tools: Bash, Read
argument-hint: <github-pr-url>
---

# GROG Review - GitHub PR Code Reviewer

Fetch a GitHub pull request and perform a thorough code review.

## Usage

When the user provides a GitHub PR URL (like `https://github.com/owner/repo/pull/123`), run:

```bash
node ~/.claude/tools/grog/index.js review $ARGUMENTS
```

The tool fetches the PR metadata, full diff, file list, existing reviews, inline comments, and conversation comments. It also downloads any image attachments from the PR description.

## IMPORTANT: Analyze Image Attachments

If the output shows "IMAGE ATTACHMENTS" with file paths, you MUST use the Read tool to view each image file. These screenshots/mockups may be critical for understanding the PR's visual changes. Do this before starting the review.

## What to do with the output

1. Run grog review to fetch the PR
2. If image paths are shown, use Read tool on EACH image file to view them
3. Summarize the PR: title, author, branch, description, and scope of changes
4. Review the diff thoroughly, checking for:
   - **Correctness**: Logic errors, edge cases, off-by-one errors, null/undefined handling
   - **Security**: Injection vulnerabilities, exposed secrets, unsafe data handling
   - **Performance**: Unnecessary re-renders, N+1 queries, missing memoization, large bundle additions
   - **Code quality**: Naming, readability, DRY violations, dead code, missing error handling
   - **Architecture**: Does it fit existing patterns? Are there better abstractions?
   - **Testing**: Are changes tested? Are there missing test cases?
   - **Types**: Missing or incorrect TypeScript types, unsafe `any` usage
5. Consider the existing review comments and reviews - note what has already been flagged
6. Provide a structured review with:
   - **Summary**: One-paragraph overview of what the PR does and its overall quality
   - **Key findings**: Organized by severity (critical, suggestion, nit)
   - **File-by-file notes**: Specific line references for actionable feedback
   - **Verdict**: APPROVE, REQUEST_CHANGES, or COMMENT with reasoning

Be constructive and specific. Reference line numbers and file paths. Suggest concrete fixes when flagging issues.

## Error Handling

- If no URL is provided, ask the user for the GitHub PR URL
- If the token is missing, inform the user to run the install script again or manually add GH_TOKEN to `~/.claude/tools/grog/.env`
EOF

echo "  > /grog-review skill"

# Skill 4: /grog-answer - Post a summary comment to a GitHub issue
cat > "$SKILLS_DIR/grog-answer/SKILL.md" << 'EOF'
---
name: grog-answer
description: Post a summary comment to a GitHub issue. Use when the user wants to post their work summary or a comment to an issue.
allowed-tools: Bash, Read, Write
argument-hint: <github-issue-url>
---

# GROG Answer - Post Summary to GitHub Issue

Post a summary of what was done as a comment on a GitHub issue.

## Usage

When the user wants to post a summary or comment to a GitHub issue:

1. Gather the summary of what was done. Sources:
   - Your own context from recent work (commits, code changes, conversation)
   - Ask the user if you're not sure what to include
2. Write the markdown summary to a temp file:
   ```bash
   # Write to a unique temp file
   SUMMARY_FILE="/tmp/grog-answer-$(date +%s).md"
   ```
   Use the Write tool to create the file with the markdown content.
3. Post it:
   ```bash
   node ~/.claude/tools/grog/index.js answer $ARGUMENTS "$SUMMARY_FILE"
   ```
4. Report what was posted (include the comment URL from the output)

## Summary Format

Write a clear markdown summary with:
- What was changed (bullet points)
- Why (link back to the issue context)
- Any notes for reviewers

Keep it concise but informative.

## Error Handling

- If no URL is provided, ask the user for the GitHub issue URL
- If the token is missing, inform the user to run the install script again or manually add GH_TOKEN to `~/.claude/tools/grog/.env`
EOF

echo "  > /grog-answer skill"

echo ""
echo "┌──────────────────────────────────────────────────────────┐"
echo "│  installation complete.                                  │"
echo "└──────────────────────────────────────────────────────────┘"
echo ""
echo "  commands available in any Claude Code session:"
echo ""
echo "    /grog-solve <issue-url>     fetch and solve a single issue"
echo "    /grog-explore <repo-url>    list all issues for batch processing"
echo "    /grog-review <pr-url>       review a pull request"
echo "    /grog-answer <issue-url>    post a summary comment to an issue"
echo ""
echo "  examples:"
echo "    /grog-solve https://github.com/owner/repo/issues/123"
echo "    /grog-explore https://github.com/orgs/myorg/projects/1"
echo "    /grog-explore https://github.com/owner/repo"
echo "    /grog-review https://github.com/owner/repo/pull/123"
echo "    /grog-answer https://github.com/owner/repo/issues/123"
echo ""
echo "  files:"
echo "    tool:   $TOOLS_DIR"
echo "    skills: $SKILLS_DIR/grog-*"
echo ""
