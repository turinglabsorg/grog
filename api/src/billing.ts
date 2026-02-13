import { Router } from "express";
import type { Request, Response } from "express";
import type { Config, CreditPack } from "@grog/shared";
import { StateManager, createLogger } from "@grog/shared";
import { requireAuth } from "./middleware.js";

const log = createLogger("billing");

const CREDIT_PACKS: CreditPack[] = [
  { id: "pack-100", credits: 100, priceUsd: 10, stripePriceId: "", label: "100 credits" },
  { id: "pack-500", credits: 500, priceUsd: 40, stripePriceId: "", label: "500 credits" },
  { id: "pack-1000", credits: 1000, priceUsd: 70, stripePriceId: "", label: "1,000 credits" },
];

export function createBillingRouter(config: Config, state: StateManager): Router {
  const router = Router();

  // Initialize Stripe lazily (only if billing enabled)
  let stripe: any = null;
  if (config.billingEnabled) {
    import("stripe").then((Stripe) => {
      stripe = new Stripe.default(config.stripeSecretKey);
    }).catch((err) => {
      log.error(`Failed to load Stripe: ${err}`);
    });
  }

  // Get current user's credit balance
  router.get("/billing/balance", requireAuth(config, state), async (req: Request, res: Response) => {
    if (!config.billingEnabled) {
      res.json({ credits: Infinity, billingEnabled: false });
      return;
    }
    const userId = (req as any).grogUserId as number;
    const balance = await state.ensureCreditBalance(userId);
    res.json({ ...balance, billingEnabled: true });
  });

  // Get credit transaction history
  router.get("/billing/transactions", requireAuth(config, state), async (req: Request, res: Response) => {
    if (!config.billingEnabled) {
      res.json([]);
      return;
    }
    const userId = (req as any).grogUserId as number;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const transactions = await state.getCreditTransactions(userId, limit);
    res.json(transactions);
  });

  // Get available credit packs
  router.get("/billing/packs", (_req: Request, res: Response) => {
    if (!config.billingEnabled) {
      res.json([]);
      return;
    }
    res.json(CREDIT_PACKS);
  });

  // Create Stripe Checkout Session
  router.post("/billing/checkout", requireAuth(config, state), async (req: Request, res: Response) => {
    if (!config.billingEnabled || !stripe) {
      res.status(400).json({ error: "Billing is not enabled" });
      return;
    }

    const { packId } = req.body as { packId?: string };
    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      res.status(400).json({ error: "Invalid pack ID" });
      return;
    }

    const userId = (req as any).grogUserId as number;

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: pack.label },
              unit_amount: pack.priceUsd * 100,
            },
            quantity: 1,
          },
        ],
        metadata: {
          grogUserId: String(userId),
          credits: String(pack.credits),
          packId: pack.id,
        },
        success_url: `${config.baseUrl}/dashboard?billing=success`,
        cancel_url: `${config.baseUrl}/dashboard?billing=cancelled`,
      });

      log.info(`Checkout session created for user ${userId}: ${session.id}`);
      res.json({ checkoutUrl: session.url });
    } catch (err) {
      log.error(`Checkout creation failed: ${(err as Error).message}`);
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  return router;
}
