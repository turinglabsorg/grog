import type { Request, Response, Express } from "express";
import express from "express";
import type { Config } from "@grog/shared";
import { StateManager, createLogger } from "@grog/shared";

const log = createLogger("stripe-webhook");

export function registerStripeWebhook(app: Express, config: Config, state: StateManager): void {
  if (!config.billingEnabled) return;

  let stripe: any = null;

  // Initialize Stripe
  import("stripe").then((Stripe) => {
    stripe = new Stripe.default(config.stripeSecretKey);
  }).catch((err) => {
    log.error(`Failed to load Stripe for webhook: ${err}`);
  });

  // Register with raw body parser (must be before global JSON parser)
  app.post(
    "/billing/webhook",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response): Promise<void> => {
      if (!stripe) {
        res.status(503).json({ error: "Stripe not initialized" });
        return;
      }

      const sig = req.headers["stripe-signature"] as string | undefined;
      if (!sig) {
        res.status(400).json({ error: "Missing stripe-signature" });
        return;
      }

      let event: any;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, config.stripeWebhookSecret);
      } catch (err) {
        log.error(`Webhook signature verification failed: ${(err as Error).message}`);
        res.status(400).json({ error: "Invalid signature" });
        return;
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const userId = parseInt(session.metadata?.grogUserId ?? "", 10);
        const credits = parseInt(session.metadata?.credits ?? "", 10);
        const sessionId = session.id as string;

        if (isNaN(userId) || isNaN(credits) || credits <= 0) {
          log.error(`Invalid session metadata: userId=${userId}, credits=${credits}`);
          res.status(400).json({ error: "Invalid metadata" });
          return;
        }

        // Idempotency check
        const existing = await state.getTransactionByStripeSession(sessionId);
        if (existing) {
          log.info(`Duplicate webhook for session ${sessionId} — skipping`);
          res.json({ received: true, duplicate: true });
          return;
        }

        // Add credits
        const balance = await state.addCredits(userId, credits);
        await state.recordCreditTransaction({
          id: `purchase-${sessionId}`,
          userId,
          type: "purchase",
          amount: credits,
          balanceAfter: balance.credits,
          stripeSessionId: sessionId,
          description: `Purchased ${credits} credits`,
          createdAt: new Date().toISOString(),
        });

        log.info(`Added ${credits} credits to user ${userId} (session ${sessionId})`);
      }

      res.json({ received: true });
    }
  );
}
