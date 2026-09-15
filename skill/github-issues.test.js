import test from "node:test";
import assert from "node:assert/strict";

import { createGitHubIssue, parseGitHubRepository } from "./github-issues.js";

test("parseGitHubRepository accepts full names and GitHub remotes", () => {
  assert.deepEqual(parseGitHubRepository("SenzaRisposta/prismanews"), {
    owner: "SenzaRisposta",
    repo: "prismanews",
    fullName: "SenzaRisposta/prismanews",
  });
  assert.equal(
    parseGitHubRepository("https://github.com/SenzaRisposta/prismanews.git")?.fullName,
    "SenzaRisposta/prismanews",
  );
  assert.equal(
    parseGitHubRepository("git@github.com:SenzaRisposta/prismanews.git")?.fullName,
    "SenzaRisposta/prismanews",
  );
});

test("parseGitHubRepository rejects malformed repositories", () => {
  assert.equal(parseGitHubRepository(""), null);
  assert.equal(parseGitHubRepository("prismanews"), null);
  assert.equal(parseGitHubRepository("https://example.com/owner/repo"), null);
});

test("createGitHubIssue sends the expected REST request", async () => {
  let request;
  const issue = await createGitHubIssue({
    token: "test-token",
    repository: "SenzaRisposta/prismanews",
    title: "Infrastructure follow-up",
    body: "Completed work",
    labels: ["infra", "operations"],
    assignees: ["octocat"],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 201,
        statusText: "Created",
        text: async () => JSON.stringify({
          number: 42,
          title: "Infrastructure follow-up",
          html_url: "https://github.com/SenzaRisposta/prismanews/issues/42",
        }),
      };
    },
  });

  assert.equal(request.url, "https://api.github.com/repos/SenzaRisposta/prismanews/issues");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(request.options.body), {
    title: "Infrastructure follow-up",
    body: "Completed work",
    labels: ["infra", "operations"],
    assignees: ["octocat"],
  });
  assert.equal(issue.number, 42);
});

test("createGitHubIssue reports GitHub API errors", async () => {
  await assert.rejects(
    createGitHubIssue({
      token: "test-token",
      repository: "SenzaRisposta/prismanews",
      title: "Infrastructure follow-up",
      fetchImpl: async () => ({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        text: async () => JSON.stringify({ message: "Validation Failed" }),
      }),
    }),
    /GitHub API error: 422 Validation Failed/,
  );
});
