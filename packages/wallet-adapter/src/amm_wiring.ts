import type { SwapIntentBuilder, SwapQuote, LiquidityIntentBuilder } from '@tari-ootle/protocol-client';
import { AmmTransactionIntent, buildSwapIntent, buildAddLiquidityIntent, buildRemoveLiquidityIntent, SwapIntentEvidenceQuote } from './amm.js';

/**
 * Wires the protocol-client AMM resolvers (which perform the authoritative reread and
 * exact-integer quote) to the signer-agnostic builders in this package.
 */
export function ammSwapIntentBuilder(accountAddress: string, operationId: () => string): SwapIntentBuilder<AmmTransactionIntent> {
  return {
    swap({ quote, minOutput, maxEpoch }) {
      const evidence: SwapIntentEvidenceQuote = {
        quotedOutput: quote.quotedOutput,
        feeBps: quote.feeBps,
        slippageBps: quote.slippageBps,
        effectiveInput: quote.effectiveInput,
        readEpoch: quote.readEpoch,
      };
      return buildSwapIntent({
        poolComponent: quote.poolComponent,
        accountAddress,
        inputResource: quote.inputResource,
        outputResource: quote.outputResource,
        rawInputAmount: quote.rawInputAmount,
        minOutput,
        maxEpoch,
        operationId: operationId(),
        quoteEvidence: evidence,
      });
    },
  };
}

export function ammLiquidityIntentBuilder(accountAddress: string, operationId: () => string): LiquidityIntentBuilder<AmmTransactionIntent> {
  return {
    addLiquidity(input) {
      return buildAddLiquidityIntent({
        poolComponent: input.poolComponent,
        accountAddress,
        resourceA: input.resourceA,
        resourceB: input.resourceB,
        rawAmountA: input.rawAmountA,
        rawAmountB: input.rawAmountB,
        maxEpoch: input.maxEpoch,
        operationId: operationId(),
      });
    },
    removeLiquidity(input) {
      return buildRemoveLiquidityIntent({
        poolComponent: input.poolComponent,
        accountAddress,
        lpResource: input.lpResource,
        rawLpAmount: input.rawLpAmount,
        maxEpoch: input.maxEpoch,
        operationId: operationId(),
      });
    },
  };
}
