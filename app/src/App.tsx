import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { getMe } from "./api";
import type { UserInfo } from "./api";
import styles from "./App.module.css";

export function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;

  return (
    <>
      <Header user={user} />

      {/* Hero */}
      <section className={styles.hero}>
        <img src="/logo.png" alt="Grog" className={styles.mascot} />
        <div className={styles.title}>GROG</div>
        <div className={styles.sub}>
          Autonomous coding agent that solves GitHub issues.
          Mention <span className={styles.highlight}>@grog</span> in any issue
          and it clones, fixes, and opens a PR.
        </div>

        <div className={styles.features}>
          <div className={styles.feature}>
            <div className={styles.featureTitle}>
              <span className={styles.prompt}>$</span> Mention to trigger
            </div>
            <div className={styles.featureDesc}>
              Tag @grog in a GitHub issue comment. It picks up the task automatically.
            </div>
          </div>
          <div className={styles.feature}>
            <div className={styles.featureTitle}>
              <span className={styles.prompt}>$</span> Autonomous solving
            </div>
            <div className={styles.featureDesc}>
              Clones the repo, reads the issue, writes code, commits, and opens a pull request.
            </div>
          </div>
          <div className={styles.feature}>
            <div className={styles.featureTitle}>
              <span className={styles.prompt}>$</span> Self-host or SaaS
            </div>
            <div className={styles.featureDesc}>
              Run your own agent, or use the hosted version with a credits-based billing system.
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>How It Works</h2>
        <p className={styles.sectionSub}>
          Grog turns GitHub issues into pull requests. No human in the loop &mdash; just tag the bot and walk away.
        </p>

        <div className={styles.flow}>
          <div className={styles.flowStep}>
            <div className={styles.flowNumber}>1</div>
            <div className={styles.flowLabel}>Mention</div>
            <div className={styles.flowDesc}>
              Comment <span className={styles.code}>@grog-agent solve this</span> on any GitHub issue.
              The webhook fires instantly.
            </div>
          </div>
          <div className={styles.flowArrow}>&rarr;</div>
          <div className={styles.flowStep}>
            <div className={styles.flowNumber}>2</div>
            <div className={styles.flowLabel}>Clone & Analyze</div>
            <div className={styles.flowDesc}>
              The agent clones the repo, reads the issue context, explores the codebase,
              and builds an understanding of what needs to change.
            </div>
          </div>
          <div className={styles.flowArrow}>&rarr;</div>
          <div className={styles.flowStep}>
            <div className={styles.flowNumber}>3</div>
            <div className={styles.flowLabel}>Code & Fix</div>
            <div className={styles.flowDesc}>
              Claude writes the code, runs tests, iterates on errors, and commits
              the changes to a dedicated branch.
            </div>
          </div>
          <div className={styles.flowArrow}>&rarr;</div>
          <div className={styles.flowStep}>
            <div className={styles.flowNumber}>4</div>
            <div className={styles.flowLabel}>Open PR</div>
            <div className={styles.flowDesc}>
              A pull request is opened with a summary of changes, linked to the original issue.
              Review and merge when ready.
            </div>
          </div>
        </div>

        <div className={styles.flowDiagram}>
          <pre className={styles.pre}>{`  @grog-agent[bot] solve this
          |
          v
  GitHub Webhook ──> Agent Server ──> MongoDB ──> Claude ──> PR`}</pre>
        </div>
      </section>

      {/* What it can do */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>What Grog Can Do</h2>
        <p className={styles.sectionSub}>
          From simple bug fixes to multi-file refactors &mdash; if it's described in an issue, Grog will take a shot at it.
        </p>

        <div className={styles.capabilities}>
          <div className={styles.capability}>
            <div className={styles.capIcon}>&#x1f41b;</div>
            <div className={styles.capTitle}>Bug Fixes</div>
            <div className={styles.capDesc}>Reads error logs and stack traces from the issue, traces the root cause through the code, and patches it.</div>
          </div>
          <div className={styles.capability}>
            <div className={styles.capIcon}>&#x2728;</div>
            <div className={styles.capTitle}>New Features</div>
            <div className={styles.capDesc}>Implements functionality described in the issue &mdash; new endpoints, UI components, CLI flags, database migrations.</div>
          </div>
          <div className={styles.capability}>
            <div className={styles.capIcon}>&#x1f504;</div>
            <div className={styles.capTitle}>Refactoring</div>
            <div className={styles.capDesc}>Restructures code, renames modules, extracts shared utilities, updates imports across the project.</div>
          </div>
          <div className={styles.capability}>
            <div className={styles.capIcon}>&#x1f9ea;</div>
            <div className={styles.capTitle}>Tests</div>
            <div className={styles.capDesc}>Writes unit and integration tests, fixes broken test suites, adds missing coverage.</div>
          </div>
          <div className={styles.capability}>
            <div className={styles.capIcon}>&#x1f4ac;</div>
            <div className={styles.capTitle}>Follow-ups</div>
            <div className={styles.capDesc}>If something is unclear, Grog asks a question on the issue. Reply and it picks up where it left off.</div>
          </div>
          <div className={styles.capability}>
            <div className={styles.capIcon}>&#x1f680;</div>
            <div className={styles.capTitle}>Auto-solve</div>
            <div className={styles.capDesc}>Enable auto-solve on a repo and every new issue gets picked up automatically &mdash; no mention needed.</div>
          </div>
        </div>
      </section>

      {/* Deployment modes */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Two Ways to Run</h2>

        <div className={styles.modes}>
          <div className={styles.mode}>
            <div className={styles.modeTitle}>Self-Hosted</div>
            <div className={styles.modeDesc}>
              Run the agent on your own server. Create a GitHub App, connect it through the built-in dashboard,
              and you're live. No external dependencies beyond MongoDB and an Anthropic API key.
              Full control over your data, your repos, and your budget.
            </div>
            <div className={styles.modeStack}>agent + shared + MongoDB</div>
          </div>
          <div className={styles.mode}>
            <div className={styles.modeTitle}>Hosted SaaS</div>
            <div className={styles.modeDesc}>
              Sign in with GitHub, pick your repos, and buy credits. We handle the infrastructure,
              scaling, and agent management. Pay per token usage &mdash; 1 credit covers 10,000 tokens.
              No server setup, no API keys to manage.
            </div>
            <div className={styles.modeStack}>app + api + agent + shared + MongoDB + Stripe</div>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>grog &mdash; built by <a href="https://turinglabs.org" target="_blank" rel="noopener noreferrer">turinglabs</a></footer>
    </>
  );
}
