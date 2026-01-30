#!/bin/bash

# GROG Installer
# Installs grog to ~/.claude/tools/grog and creates the Claude Code skills

set -e

# Colors for pretty output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}"
echo "  ▄████  ██▀███   ▒█████    ▄████ "
echo " ██▒ ▀█▒▓██ ▒ ██▒▒██▒  ██▒ ██▒ ▀█▒"
echo "▒██░▄▄▄░▓██ ░▄█ ▒▒██░  ██▒▒██░▄▄▄░"
echo "░▓█  ██▓▒██▀▀█▄  ▒██   ██░░▓█  ██▓"
echo "░▒▓███▀▒░██▓ ▒██▒░ ████▓▒░░▒▓███▀▒"
echo " ░▒   ▒ ░ ▒▓ ░▒▓░░ ▒░▒░▒░  ░▒   ▒ "
echo -e "${NC}"
echo -e "${YELLOW}GitHub Issue Fetcher for Claude Code${NC}"
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Target directories
TOOLS_DIR="$HOME/.claude/tools/grog"
SKILLS_DIR="$HOME/.claude/skills"

echo -e "${CYAN}[1/5]${NC} Creating directories..."
mkdir -p "$TOOLS_DIR"
mkdir -p "$SKILLS_DIR/grog-solve"
mkdir -p "$SKILLS_DIR/grog-explore"
# Remove old /grog skill if it exists
rm -rf "$SKILLS_DIR/grog" 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} Created $TOOLS_DIR"
echo -e "  ${GREEN}✓${NC} Created skill directories"

echo ""
echo -e "${CYAN}[2/5]${NC} Copying files..."
cp "$SCRIPT_DIR/index.js" "$TOOLS_DIR/"
cp "$SCRIPT_DIR/package.json" "$TOOLS_DIR/"
echo -e "  ${GREEN}✓${NC} Copied index.js and package.json"

echo ""
echo -e "${CYAN}[3/5]${NC} Installing dependencies..."
cd "$TOOLS_DIR"
npm install --silent
echo -e "  ${GREEN}✓${NC} Dependencies installed"

echo ""
echo -e "${CYAN}[4/5]${NC} Configuring GitHub token..."
echo ""
echo -e "${YELLOW}To fetch GitHub issues, grog needs a Personal Access Token.${NC}"
echo -e "You can create one at: ${CYAN}https://github.com/settings/tokens${NC}"
echo -e "Required scope: ${GREEN}repo${NC} (for private repos) or ${GREEN}public_repo${NC} (for public only)"
echo ""

# Check if token already exists
if [ -f "$TOOLS_DIR/.env" ] && grep -q "GH_TOKEN=" "$TOOLS_DIR/.env"; then
    echo -e "${YELLOW}A token already exists in $TOOLS_DIR/.env${NC}"
    read -p "Do you want to replace it? (y/N): " REPLACE_TOKEN
    if [[ ! "$REPLACE_TOKEN" =~ ^[Yy]$ ]]; then
        echo -e "  ${GREEN}✓${NC} Keeping existing token"
        SKIP_TOKEN=true
    fi
fi

if [ "$SKIP_TOKEN" != "true" ]; then
    read -p "Enter your GitHub token (ghp_...): " GH_TOKEN

    if [ -z "$GH_TOKEN" ]; then
        echo -e "  ${RED}✗${NC} No token provided. You'll need to add it manually to $TOOLS_DIR/.env"
        echo "GH_TOKEN=" > "$TOOLS_DIR/.env"
    else
        echo "GH_TOKEN=$GH_TOKEN" > "$TOOLS_DIR/.env"
        chmod 600 "$TOOLS_DIR/.env"
        echo -e "  ${GREEN}✓${NC} Token saved to $TOOLS_DIR/.env"
    fi
fi

echo ""
echo -e "${CYAN}[5/5]${NC} Creating Claude Code skills..."

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

echo -e "  ${GREEN}✓${NC} Created /grog-solve skill"

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

echo -e "  ${GREEN}✓${NC} Created /grog-explore skill"

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Installation complete! 🏴‍☠️${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "You can now use these commands in any Claude Code session:"
echo ""
echo -e "  ${CYAN}/grog-solve${NC} <issue-url>  - Fetch and solve a single issue"
echo -e "  ${CYAN}/grog-explore${NC} <repo-url> - List all issues for batch processing"
echo ""
echo -e "Examples:"
echo -e "  ${YELLOW}/grog-solve https://github.com/owner/repo/issues/123${NC}"
echo -e "  ${YELLOW}/grog-explore https://github.com/orgs/myorg/projects/1${NC}"
echo -e "  ${YELLOW}/grog-explore https://github.com/owner/repo${NC}"
echo ""
echo -e "Files installed to:"
echo -e "  Tool:   ${CYAN}$TOOLS_DIR${NC}"
echo -e "  Skills: ${CYAN}$SKILLS_DIR/grog-*${NC}"
echo ""
