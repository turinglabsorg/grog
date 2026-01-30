# GROG

> *"Arr matey, fetch me that issue or walk the plank!"*

Because clicking through GitHub like a landlubber is for scallywags. Real pirates use the command line.

## What in Davy Jones' locker is this?

GROG is a CLI tool that fetches GitHub issues faster than you can say "shiver me timbers." It grabs issue titles, descriptions, and all that juicy metadata without ever leaving your beloved terminal.

Why is it called GROG? Because after debugging production issues at 3 AM, you'll need a drink. Also, **G**itHub **R**etrieving **O**perations **G**adget. *(We made up that acronym after naming it, obviously.)*

## Features

- **`/grog-solve`** - Fetch a single GitHub issue and solve it
- **`/grog-explore`** - Explore all issues from a GitHub Project or repository
  - Supports GitHub Projects (multi-repo kanban boards)
  - Supports single repositories
  - Groups issues by status (for projects) or labels (for repos)
  - Hides completed/done issues automatically
  - Paginated API calls to fetch ALL issues (not just the first 100)
- **Automatic image downloads** - Screenshots and mockups saved to `/tmp/grog-attachments/`

## Installation

### For Claude Code (Recommended)

Run the installer:

```bash
./install.sh
```

This will:
- Install grog to `~/.claude/tools/grog`
- Create `/grog-solve` and `/grog-explore` skills for Claude Code
- Ask for your GitHub token and store it securely

Then in any Claude Code session:

```bash
# Solve a single issue
/grog-solve https://github.com/owner/repo/issues/123

# Explore all issues in a GitHub Project
/grog-explore https://github.com/orgs/myorg/projects/1

# Explore all issues in a repository
/grog-explore https://github.com/owner/repo
```

### Manual Installation

```bash
npm install
```

Create a `.env` file with your GitHub token:

```env
GH_TOKEN=your_token_here
```

## Usage

### Solve a Single Issue

```bash
node index.js solve https://github.com/owner/repo/issues/123
```

Fetches the issue details, downloads any image attachments, and displays everything for you to start working on it.

### Explore a GitHub Project

```bash
node index.js explore https://github.com/orgs/myorg/projects/1
```

Lists all issues from the project, grouped by status. Done issues are hidden by default. Perfect for batch processing a backlog.

**Supported URL formats:**
- Org Projects: `https://github.com/orgs/orgname/projects/123`
- User Projects: `https://github.com/users/username/projects/123`
- Repositories: `https://github.com/owner/repo`

### Example Output (Explore)

```
============================================================
PROJECT: My Awesome Project
============================================================
URL: https://github.com/orgs/myorg/projects/1

Found 220 issue(s) total (173 done, 47 active):

STATUSES:
----------------------------------------
  [Questions] - 11 issue(s)
  [Ideas] - 3 issue(s)
  [Bug] - 0 issue(s)
  [Backlog] - 23 issue(s)
  [Todo] - 5 issue(s)
  [In Progress] - 0 issue(s)
  [Testing] - 5 issue(s)
  [Done] - 173 issue(s) (hidden)

============================================================
NEXT STEPS:
============================================================

Active issues:
  myorg/repo#114 Fix the login button
  myorg/repo#75 Update documentation
  ...
```

## What You Get (Solve)

```
============================================================
Issue #42: The answer to life, the universe, and everything
============================================================
State: open
Author: some-dev
Created: 1/15/2024, 3:00:00 AM
Labels: bug, help-wanted
------------------------------------------------------------

Description:

The login button sometimes logs you out. Other times it orders pizza.
We're not sure which is the bug.

============================================================

IMAGE ATTACHMENTS (use Read tool to analyze these):
============================================================
/tmp/grog-attachments/repo-issue-42-img-1.png
```

## Requirements

- Node.js 18+ (for native fetch support)
- A GitHub Personal Access Token with `repo` scope
- A burning desire to never leave the terminal

## The GitHub Token Situation

Get one at: https://github.com/settings/tokens

Required scopes:
- `repo` - To read issues and projects
- `read:project` - For GitHub Projects v2 access (if using projects)

## FAQ

**Q: Why two commands instead of one?**
A: Because `/grog-solve` is for "I know exactly what issue I want to fix" and `/grog-explore` is for "show me everything and let me pick."

**Q: Why are Done issues hidden?**
A: Because you don't need to see 173 completed issues when you're trying to find work to do.

**Q: Can it fetch more than 100 issues?**
A: Yes! We paginate through all items automatically. No artificial limits here.

**Q: Why is there a pirate theme?**
A: Blame sleep deprivation and the fact that "grog" is a pirate drink.

## License

ISC

---

*Made with mass amounts of mass amounts of mass amounts of rum*

```
    _____
   /     \
  | () () |
   \  ^  /
    |||||     "Arr, now go fetch some issues, ye scurvy developer!"
    |||||
```
