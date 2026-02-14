import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { getMe } from "./api";
import type { UserInfo } from "./api";
import styles from "./App.module.css";

const base = import.meta.env.BASE_URL;

export function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));

    fetch("https://api.github.com/repos/turinglabsorg/grog")
      .then(r => r.json())
      .then(d => { if (d.stargazers_count != null) setStars(d.stargazers_count); })
      .catch(() => {});
  }, []);

  if (loading) return null;

  return (
    <>
      <Header user={user} />

      {/* Hero */}
      <section className={styles.hero}>
        <div className={styles.heroGlow} />
        <img src={`${base}logo.png`} alt="Grog" className={styles.mascot} />
        <div className={styles.title}>GROG</div>
        <div className={styles.sub}>
          Autonomous coding agent that solves GitHub issues.
          Mention <span className={styles.highlight}>@grog</span> in any issue
          and it clones, fixes, and opens a PR.
        </div>

        <div className={styles.heroCtas}>
          <a href="#install" className={styles.heroCta}>Get Started</a>
          <a
            href="https://github.com/turinglabsorg/grog"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.heroCtaSecondary}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            GitHub{stars != null ? ` (${stars})` : ''}
          </a>
        </div>

        {/* Terminal demo */}
        <div className={styles.terminal}>
          <div className={styles.termBar}>
            <span className={styles.termDot} data-color="red" />
            <span className={styles.termDot} data-color="yellow" />
            <span className={styles.termDot} data-color="green" />
            <span className={styles.termFile}>github.com/your-org/your-repo/issues/42</span>
          </div>
          <div className={styles.termBody}>
            <div className={styles.termLine}>
              <span className={styles.termUser}>@you</span>
              <span className={styles.termComment}>commented on issue #42</span>
            </div>
            <div className={styles.termLine}>
              <span className={styles.termMention}>@grog-agent</span>{' '}
              <span className={styles.termText}>solve this</span>
            </div>
            <div className={styles.termDivider} />
            <div className={styles.termLine}>
              <span className={styles.termBot}>grog-agent</span>
              <span className={styles.termComment}>opened a pull request</span>
            </div>
            <div className={styles.termLine}>
              <span className={styles.termPr}>#43</span>{' '}
              <span className={styles.termText}>Fix null check in auth middleware</span>
            </div>
            <div className={styles.termLine}>
              <span className={styles.termFiles}>3 files changed</span>
              <span className={styles.termAdd}>+24</span>
              <span className={styles.termDel}>-8</span>
            </div>
          </div>
        </div>
      </section>

      {/* How it works — vertical timeline */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>How It Works</h2>
        <p className={styles.sectionSub}>
          Grog turns GitHub issues into pull requests. No human in the loop &mdash; just tag the bot and walk away.
        </p>

        <div className={styles.timeline}>
          <div className={styles.timelineLine} />

          <div className={styles.timelineStep}>
            <div className={styles.timelineNumber}>1</div>
            <div className={styles.timelineContent}>
              <div className={styles.timelineLabel}>Mention</div>
              <div className={styles.timelineDesc}>
                Comment <span className={styles.code}>@grog-agent solve this</span> on any GitHub issue.
                The webhook fires instantly.
              </div>
            </div>
          </div>

          <div className={styles.timelineStep}>
            <div className={styles.timelineNumber}>2</div>
            <div className={styles.timelineContent}>
              <div className={styles.timelineLabel}>Clone & Analyze</div>
              <div className={styles.timelineDesc}>
                The agent clones the repo, reads the issue context, explores the codebase,
                and builds an understanding of what needs to change.
              </div>
            </div>
          </div>

          <div className={styles.timelineStep}>
            <div className={styles.timelineNumber}>3</div>
            <div className={styles.timelineContent}>
              <div className={styles.timelineLabel}>Code & Fix</div>
              <div className={styles.timelineDesc}>
                Claude writes the code, runs tests, iterates on errors, and commits
                the changes to a dedicated branch.
              </div>
            </div>
          </div>

          <div className={styles.timelineStep}>
            <div className={styles.timelineNumber}>4</div>
            <div className={styles.timelineContent}>
              <div className={styles.timelineLabel}>Open PR</div>
              <div className={styles.timelineDesc}>
                A pull request is opened with a summary of changes, linked to the original issue.
                Review and merge when ready.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* What it can do — featured + grid */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>What Grog Can Do</h2>
        <p className={styles.sectionSub}>
          From simple bug fixes to multi-file refactors &mdash; if it's described in an issue, Grog will take a shot at it.
        </p>

        <div className={styles.capFeatured}>
          <div className={styles.capFeaturedCard}>
            <div className={styles.capFeaturedIcon}>&#x1f41b;</div>
            <div>
              <div className={styles.capFeaturedTitle}>Bug Fixes</div>
              <div className={styles.capFeaturedDesc}>
                Reads error logs and stack traces from the issue, traces the root cause through
                the code, and patches it. Handles multi-file bugs across your entire codebase.
              </div>
            </div>
          </div>
          <div className={styles.capFeaturedCard}>
            <div className={styles.capFeaturedIcon}>&#x2728;</div>
            <div>
              <div className={styles.capFeaturedTitle}>New Features</div>
              <div className={styles.capFeaturedDesc}>
                Implements functionality described in the issue &mdash; new endpoints, UI components,
                CLI flags, database migrations. From spec to working code autonomously.
              </div>
            </div>
          </div>
        </div>

        <div className={styles.capGrid}>
          <div className={styles.capSmall}>
            <span className={styles.capSmallIcon}>&#x1f504;</span>
            <div>
              <div className={styles.capSmallTitle}>Refactoring</div>
              <div className={styles.capSmallDesc}>Restructures code, renames modules, extracts shared utilities, updates imports across the project.</div>
            </div>
          </div>
          <div className={styles.capSmall}>
            <span className={styles.capSmallIcon}>&#x1f9ea;</span>
            <div>
              <div className={styles.capSmallTitle}>Tests</div>
              <div className={styles.capSmallDesc}>Writes unit and integration tests, fixes broken test suites, adds missing coverage.</div>
            </div>
          </div>
          <div className={styles.capSmall}>
            <span className={styles.capSmallIcon}>&#x1f4ac;</span>
            <div>
              <div className={styles.capSmallTitle}>Dashboard Chat</div>
              <div className={styles.capSmallDesc}>Talk to the agent while it works. Send messages from the dashboard &mdash; the agent pauses, reads your input, and continues.</div>
            </div>
          </div>
          <div className={styles.capSmall}>
            <span className={styles.capSmallIcon}>&#x1f680;</span>
            <div>
              <div className={styles.capSmallTitle}>Auto-solve</div>
              <div className={styles.capSmallDesc}>Enable auto-solve on a repo and every new issue gets picked up automatically &mdash; no mention needed.</div>
            </div>
          </div>
        </div>
      </section>

      {/* CLI Skills */}
      <section className={styles.section} id="install">
        <h2 className={styles.sectionTitle}>CLI Skills</h2>
        <p className={styles.sectionSub}>
          Use Grog directly from your terminal inside any Claude Code session.
          No server needed &mdash; runs locally with your GitHub account.
        </p>

        <div className={styles.skillsTerminal}>
          <div className={styles.termBar}>
            <span className={styles.termDot} data-color="red" />
            <span className={styles.termDot} data-color="yellow" />
            <span className={styles.termDot} data-color="green" />
            <span className={styles.termFile}>claude code</span>
          </div>
          <div className={styles.skillsTermBody}>
            <div className={styles.skillRow}>
              <div className={styles.skillCmdLine}>
                <span className={styles.skillPrompt}>$</span>
                <span className={styles.skillCmd}>/grog-solve</span>
                <span className={styles.skillArg}>{'<issue-url>'}</span>
              </div>
              <div className={styles.skillDesc}>
                Fetches a GitHub issue, analyzes the codebase, implements the fix, and commits the changes.
              </div>
            </div>
            <div className={styles.skillRow}>
              <div className={styles.skillCmdLine}>
                <span className={styles.skillPrompt}>$</span>
                <span className={styles.skillCmd}>/grog-review</span>
                <span className={styles.skillArg}>{'<pr-url>'}</span>
              </div>
              <div className={styles.skillDesc}>
                Fetches a pull request with full diff and review history. Posts a thorough code review directly on the PR.
              </div>
            </div>
            <div className={styles.skillRow}>
              <div className={styles.skillCmdLine}>
                <span className={styles.skillPrompt}>$</span>
                <span className={styles.skillCmd}>/grog-explore</span>
                <span className={styles.skillArg}>{'<repo-url>'}</span>
              </div>
              <div className={styles.skillDesc}>
                Lists all open issues from a repository or GitHub Project. Batch-process them one by one.
              </div>
            </div>
            <div className={styles.skillRow}>
              <div className={styles.skillCmdLine}>
                <span className={styles.skillPrompt}>$</span>
                <span className={styles.skillCmd}>/grog-answer</span>
                <span className={styles.skillArg}>{'<issue-url>'}</span>
              </div>
              <div className={styles.skillDesc}>
                Posts a summary comment to a GitHub issue with context from your recent work.
              </div>
            </div>
            <div className={styles.skillRow}>
              <div className={styles.skillCmdLine}>
                <span className={styles.skillPrompt}>$</span>
                <span className={styles.skillCmd}>/grog-talk</span>
              </div>
              <div className={styles.skillDesc}>
                Opens a Telegram bridge. Walk away from the terminal and keep interacting with Claude Code from your phone.
              </div>
            </div>
          </div>
        </div>

        <h3 className={styles.installTitle}>Installation</h3>

        <div className={styles.installSteps}>
          <div className={styles.installStep}>
            <div className={styles.installNumber}>1</div>
            <div className={styles.installContent}>
              <div className={styles.installLabel}>Clone the repo</div>
              <div className={styles.codeBlock}>
                <pre className={styles.pre}>{'git clone https://github.com/turinglabsorg/grog.git'}</pre>
              </div>
            </div>
          </div>
          <div className={styles.installStep}>
            <div className={styles.installNumber}>2</div>
            <div className={styles.installContent}>
              <div className={styles.installLabel}>Run the installer</div>
              <div className={styles.codeBlock}>
                <pre className={styles.pre}>{'cd grog/skill && ./install.sh'}</pre>
              </div>
              <div className={styles.installHint}>
                Copies the grog tool to <span className={styles.code}>~/.claude/tools/grog/</span>,
                installs dependencies, and creates the skill files in <span className={styles.code}>~/.claude/skills/</span>.
              </div>
            </div>
          </div>
          <div className={styles.installStep}>
            <div className={styles.installNumber}>3</div>
            <div className={styles.installContent}>
              <div className={styles.installLabel}>Create a GitHub token</div>
              <div className={styles.installHint}>
                Go to <span className={styles.code}>github.com/settings/tokens</span> and generate a
                Personal Access Token (classic) with <span className={styles.code}>repo</span> scope.
                The installer will ask you to paste it.
                Your token is stored locally in <span className={styles.code}>~/.claude/tools/grog/.env</span> and never leaves your machine.
              </div>
            </div>
          </div>
          <div className={styles.installStep}>
            <div className={styles.installNumber}>4</div>
            <div className={styles.installContent}>
              <div className={styles.installLabel}>Use it</div>
              <div className={styles.codeBlock}>
                <pre className={styles.pre}>{`/grog-solve https://github.com/owner/repo/issues/42
/grog-review https://github.com/owner/repo/pull/15
/grog-explore https://github.com/owner/repo`}</pre>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.skillNote}>
          All actions &mdash; comments, reviews, pushes &mdash; appear under your GitHub account.
          Your token stays on your machine. To update, <span className={styles.code}>git pull</span> and re-run the installer.
        </div>
      </section>

      {/* Big Plan */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>The Big Plan</h2>
        <p className={styles.sectionSub}>
          Grog started as a CLI skill. We're building toward a fully autonomous agent you can deploy anywhere.
        </p>

        <div className={styles.roadmap}>
          <div className={`${styles.roadmapItem} ${styles.roadmapDone}`}>
            <div className={styles.roadmapStatus}>live</div>
            <div className={styles.roadmapTitle}>CLI Skills</div>
            <div className={styles.roadmapDesc}>
              Run Grog from your terminal inside Claude Code. Solve issues, review PRs,
              explore repos &mdash; all locally with your GitHub token.
            </div>
          </div>

          <div className={`${styles.roadmapItem} ${styles.roadmapBeta}`}>
            <div className={styles.roadmapStatus}>testable now</div>
            <div className={styles.roadmapTitle}>Self-Hosted Agent</div>
            <div className={styles.roadmapDesc}>
              Run the full autonomous agent on your own server.
              Create a GitHub App, connect it through the built-in dashboard,
              and mention <span className={styles.code}>@your-bot solve this</span> on
              any issue &mdash; it clones, fixes, and opens a PR automatically.
              Create jobs directly from the dashboard, chat with the agent while it works,
              and steer it in real time.
            </div>

            <div className={styles.roadmapSetup}>
              <div className={styles.roadmapSetupTitle}>Quick setup</div>
              <div className={styles.codeBlock}>
                <pre className={styles.pre}>{`git clone https://github.com/turinglabsorg/grog.git
cd grog && yarn install && yarn build
cp agent/.env.example agent/.env
# Set MONGODB_URI and ANTHROPIC_API_KEY in agent/.env
yarn dev:agent`}</pre>
              </div>
              <div className={styles.roadmapSetupHint}>
                Open <span className={styles.code}>http://localhost:3000</span> to access the dashboard,
                connect your GitHub App, and start processing issues.
                Needs Node 20+, MongoDB, and an Anthropic API key.
              </div>
            </div>
          </div>

          <div className={`${styles.roadmapItem} ${styles.roadmapSoon}`}>
            <div className={styles.roadmapStatus}>coming soon</div>
            <div className={styles.roadmapTitle}>Cloud</div>
            <div className={styles.roadmapDesc}>
              Sign in with GitHub, pick your repos, buy credits.
              We handle infrastructure, scaling, and agent management.
              No server, no API keys &mdash; just pay for what you use.
            </div>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>grog &mdash; built by <a href="https://turinglabs.org" target="_blank" rel="noopener noreferrer">turinglabs</a></footer>
    </>
  );
}
