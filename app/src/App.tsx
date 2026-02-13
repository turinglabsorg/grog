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
      <div className={styles.hero}>
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
      </div>

      <footer className={styles.footer}>grog &mdash; powered by claude</footer>
    </>
  );
}
