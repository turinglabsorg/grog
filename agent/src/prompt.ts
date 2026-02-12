import type { Issue, Comment, Config } from "./types.js";

export function buildSolvePrompt(
  issue: Issue,
  comments: Comment[],
  repoPath: string,
  config: Config
): string {
  const commentBlock = comments
    .map(
      (c) =>
        `--- @${c.user.login} (${c.created_at}) ---\n${c.body}`
    )
    .join("\n\n");

  const labelsStr =
    issue.labels.length > 0
      ? issue.labels.map((l) => l.name).join(", ")
      : "none";

  return `You are Grog, an autonomous coding agent. You have been assigned a GitHub issue to solve.

## Issue #${issue.number}: ${issue.title}

**Author:** @${issue.user.login}
**Labels:** ${labelsStr}
**URL:** ${issue.html_url}

### Description

${issue.body ?? "(no description)"}

${comments.length > 0 ? `### Comments\n\n${commentBlock}` : ""}

## Your Task

You are working in a cloned repository at: ${repoPath}
The branch \`grog/issue-${issue.number}\` has been created for you.

1. Read and understand the issue and all comments above.
2. Explore the codebase to understand the relevant code.
3. Implement the fix or feature requested in the issue.
4. Make clean, well-structured commits with descriptive messages.
5. Make sure the code works — run any available tests if applicable.

## Output Format

When you are done, output EXACTLY ONE of the following on its own line:

If you successfully implemented the solution:
\`\`\`
RESULT: PR_READY
\`\`\`

If you need more information or the issue is ambiguous:
\`\`\`
RESULT: NEEDS_CLARIFICATION
<your questions here, one per line>
\`\`\`

## Rules

- Do NOT push the branch — the server will handle pushing and PR creation.
- Do NOT create a pull request — the server will handle it.
- DO commit your changes to the current branch.
- Keep changes minimal and focused on the issue.
- If the issue is unclear or you cannot solve it, use NEEDS_CLARIFICATION and explain what you need.
`;
}
