import type { SwapIntentBuilder, SwapQuote, LiquidityIntentBuilder, MultiHopIntentBuilder } from '@tari-ootle/protocol-client';
import { AmmTransactionIntent, buildSwapIntent, buildAddLiquidityIntent, buildRemoveLiquidityIntent, buildMultiHopSwapIntent, SwapIntentEvidenceQuote } from './amm.js';

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

/**
 * Wires `resolveMultiHopSwap` to the builders: a one-hop route is an ordinary swap intent,
 * a 2..3-hop route is ONE atomic multi-hop transaction (never sequential submissions).
 */
export function ammRouteIntentBuilder(accountAddress: string, operationId: () => string): MultiHopIntentBuilder<AmmTransactionIntent> {
  return {
    multiHopSwap({ quote, minOutput, maxEpoch, slippageBps }) {
      if (quote.hops.length === 1) {
        const hop = quote.hops[0]!;
        const effective = (BigInt(hop.amountIn) * (10_000n - BigInt(hop.feeBps))) / 10_000n;
        return buildSwapIntent({
          poolComponent: hop.poolComponent,
          accountAddress,
          inputResource: hop.inputResource,
          outputResource: hop.outputResource,
          rawInputAmount: hop.amountIn,
          minOutput,
          maxEpoch,
          operationId: operationId(),
          quoteEvidence: { quotedOutput: hop.amountOut, feeBps: hop.feeBps, slippageBps, effectiveInput: String(effective) },
        });
      }
      return buildMultiHopSwapIntent({
        accountAddress,
        rawInputAmount: quote.amountIn,
        hops: quote.hops.map((h) => ({ poolComponent: h.poolComponent, inputResource: h.inputResource, outputResource: h.outputResource, quotedOutput: h.amountOut, feeBps: h.feeBps })),
        minOutput,
        maxEpoch,
        operationId: operationId(),
        slippageBps,
      });
    },
  };
}
