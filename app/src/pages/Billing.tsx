import { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { getMe, getBalance, getPacks, getTransactions, checkout } from "../api";
import type { UserInfo, CreditBalance, CreditPack, CreditTransaction } from "../api";
import styles from "./Billing.module.css";

export function Billing() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [toast, setToast] = useState<{ msg: string; ok?: boolean } | null>(null);

  useEffect(() => {
    getMe().then(setUser).catch(() => setUser(null));
    getBalance().then(setBalance).catch(() => {});
    getPacks().then(setPacks).catch(() => {});
    getTransactions().then(setTransactions).catch(() => {});

    const params = new URLSearchParams(window.location.search);
    if (params.get("billing") === "success") {
      setToast({ msg: "Payment successful! Credits added.", ok: true });
      history.replaceState({}, "", "/billing");
    }
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  async function buyPack(packId: string) {
    try {
      const data = await checkout(packId);
      if (data.checkoutUrl) window.location.href = data.checkoutUrl;
    } catch {
      setToast({ msg: "Checkout failed" });
    }
  }

  return (
    <>
      <Header user={user} />
      <div className={styles.container}>
        <h2 className={styles.heading}>Billing</h2>

        <div className={styles.balanceCard}>
          {!balance ? (
            "Loading..."
          ) : balance.billingEnabled === false ? (
            <>
              <div className={styles.balanceLabel}>Credits</div>
              <div className={styles.balanceAmount}>Unlimited</div>
              <div className={styles.balanceSub}>Self-hosted mode</div>
            </>
          ) : (
            <>
              <div className={styles.balanceLabel}>Credit Balance</div>
              <div className={styles.balanceAmount}>{balance.credits}</div>
              <div className={styles.balanceSub}>
                ~{(balance.credits * 10000).toLocaleString()} tokens | Purchased: {balance.lifetimePurchased} | Used: {balance.lifetimeUsed}
              </div>
            </>
          )}
        </div>

        {packs.length > 0 && (
          <>
            <h3 className={styles.sectionTitle}>Buy Credits</h3>
            <div className={styles.packsGrid}>
              {packs.map((p) => (
                <button key={p.id} className={styles.packCard} onClick={() => buyPack(p.id)}>
                  <div className={styles.packCredits}>{p.credits}</div>
                  <div className={styles.packPrice}>${p.priceUsd}</div>
                  <div className={styles.packPer}>
                    {((p.priceUsd / p.credits) * 100).toFixed(1)}c per credit
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        <h3 className={styles.sectionTitle}>Transaction History</h3>
        {transactions.length === 0 ? (
          <p className={styles.empty}>No transactions yet.</p>
        ) : (
          <table className={styles.txTable}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Balance</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id}>
                  <td>{new Date(tx.createdAt).toLocaleString()}</td>
                  <td>{tx.type}</td>
                  <td className={tx.amount >= 0 ? styles.txPositive : styles.txNegative}>
                    {tx.amount >= 0 ? "+" : ""}{tx.amount}
                  </td>
                  <td>{tx.balanceAfter}</td>
                  <td>{tx.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {toast && (
        <div className={styles.toastBox}>
          <div className={`${styles.toast} ${toast.ok ? styles.toastOk : ""}`}>
            {toast.msg}
          </div>
        </div>
      )}
    </>
  );
}
