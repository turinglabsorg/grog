const API_BASE = "";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

export interface UserInfo {
  githubId: number;
  login: string;
  avatarUrl: string;
}

export interface CreditBalance {
  credits: number;
  lifetimePurchased: number;
  lifetimeUsed: number;
  billingEnabled: boolean;
}

export interface CreditPack {
  id: string;
  credits: number;
  priceUsd: number;
  label: string;
}

export interface CreditTransaction {
  id: string;
  type: "purchase" | "deduction" | "refund" | "grant";
  amount: number;
  balanceAfter: number;
  description: string;
  createdAt: string;
}

export function getMe() {
  return apiFetch<UserInfo>("/auth/me");
}

export function getBalance() {
  return apiFetch<CreditBalance>("/billing/balance");
}

export function getPacks() {
  return apiFetch<CreditPack[]>("/billing/packs");
}

export function getTransactions(limit = 50) {
  return apiFetch<CreditTransaction[]>(`/billing/transactions?limit=${limit}`);
}

export function checkout(packId: string) {
  return apiFetch<{ checkoutUrl: string }>("/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packId }),
  });
}
