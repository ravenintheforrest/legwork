// Cost-per-right-answer (rule 5): every model call is priced and metered, and the
// runner kills a run that passes its registry ceiling.

export const PRICES_PER_MTOK: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-5": { in: 5, out: 25 },
};

export class CostCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostCeilingError";
  }
}

export class CostMeter {
  tokensIn = 0;
  tokensOut = 0;
  costUsd = 0;

  constructor(readonly ceilingUsd: number) {}

  charge(model: string, tokensIn: number, tokensOut: number): void {
    const price = PRICES_PER_MTOK[model];
    // Unknown model: refuse rather than bill blind.
    if (!price) throw new Error(`no price for model "${model}" — add it to PRICES_PER_MTOK`);

    this.tokensIn += tokensIn;
    this.tokensOut += tokensOut;
    this.costUsd += (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out;

    if (this.costUsd > this.ceilingUsd) {
      throw new CostCeilingError(
        `cost ceiling exceeded: $${this.costUsd.toFixed(4)} > $${this.ceilingUsd.toFixed(2)}`,
      );
    }
  }
}
