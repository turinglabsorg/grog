import { loadConfig, StateManager } from "@grog/shared";

async function main() {
  const [target, amountStr] = process.argv.slice(2);

  if (!target || !amountStr) {
    console.error("Usage: npx tsx cli/grant-credits.ts <github-login-or-id> <amount>");
    process.exit(1);
  }

  const amount = parseInt(amountStr, 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error("Error: amount must be a positive integer");
    process.exit(1);
  }

  const config = loadConfig();
  const state = await StateManager.connect(config.mongodbUri);

  // Determine if target is a numeric GitHub ID or a login string
  const isNumeric = /^\d+$/.test(target);
  const user = isNumeric
    ? await state.getUserByGithubId(parseInt(target, 10))
    : await state.getUserByLogin(target);

  if (!user) {
    console.error(`Error: user not found: ${target}`);
    process.exit(1);
  }

  const balance = await state.addCredits(user.githubId, amount);

  await state.recordCreditTransaction({
    id: `grant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: user.githubId,
    type: "grant",
    amount,
    balanceAfter: balance.credits,
    description: `CLI grant of ${amount} credits`,
    createdAt: new Date().toISOString(),
  });

  console.log(`Granted ${amount} credits to ${user.login} (GitHub ID: ${user.githubId})`);
  console.log(`New balance: ${balance.credits} credits`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`Failed: ${err}`);
  process.exit(1);
});
