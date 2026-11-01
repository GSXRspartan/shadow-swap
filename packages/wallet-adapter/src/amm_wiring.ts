import type { SwapIntentBuilder, SwapQuote, LiquidityIntentBuilder, MultiHopIntentBuilder } from '@tari-ootle/protocol-client';
import { AmmTransactionIntent, buildSwapIntent, buildAddLiquidityIntent, buildRemoveLiquidityIntent, buildMultiHopSwapIntent, buildRevealedSwapIntent, SwapIntentEvidenceQuote, type PoolVenue } from './amm.js';

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
 * Classifies a hop's pool component by the template address in its own authoritative read.
 *
 * The caller supplies this because only the application knows which template addresses it
 * has RECORDED for the verified network generation. Returning `undefined` means "not a
 * template I recognise", and the builder then refuses the route rather than guessing a venue
 * it would have to disclose.
 */
export type PoolVenueClassifier = (templateAddress: string) => PoolVenue | undefined;

/**
 * Wires `resolveMultiHopSwap` to the builders: a one-hop route is an ordinary swap intent,
 * a 2..3-hop route is ONE atomic multi-hop transaction (never sequential submissions).
 *
 * `classifyVenue` is optional. Without it every hop is assumed to be a public pool, which is
 * the historical behaviour and is safe only because the caller that omits it quotes public
 * pools exclusively. Supply it to route through revealed-value pools: a one-hop revealed
 * route builds the revealed-pool swap intent, and a route that crosses both kinds builds one
 * atomic mixed transaction carrying each hop's venue as evidence.
 */
export function ammRouteIntentBuilder(
  accountAddress: string,
  operationId: () => string,
  classifyVenue?: PoolVenueClassifier,
): MultiHopIntentBuilder<AmmTransactionIntent> {
  return {
    multiHopSwap({ quote, minOutput, maxEpoch, slippageBps, templateAddresses }) {
      // Venues come from the components' own template addresses, in route order. A hop whose
      // template is not recorded is refused here: an unclassifiable venue cannot be disclosed,
      // and an undisclosed revealed-value hop would be exactly the pseudo-privacy this
      // protocol refuses to ship.
      let venues: (PoolVenue | undefined)[] = quote.hops.map(() => undefined);
      if (classifyVenue !== undefined) {
        if (templateAddresses.length !== quote.hops.length) {
          throw new Error(`the route has ${quote.hops.length} hops but ${templateAddresses.length} template addresses were read`);
        }
        venues = templateAddresses.map((template, i) => {
          if (template === undefined) {
            throw new Error(`hop ${i + 1} (${quote.hops[i]!.poolComponent}) did not report its template, so its venue cannot be named or disclosed`);
          }
          const venue = classifyVenue(template);
          if (venue === undefined) {
            throw new Error(`hop ${i + 1} (${quote.hops[i]!.poolComponent}) reports template ${template}, which is not a recorded Shadow Swap pool template`);
          }
          return venue;
        });
      }

      if (quote.hops.length === 1) {
        const hop = quote.hops[0]!;
        const effective = (BigInt(hop.amountIn) * (10_000n - BigInt(hop.feeBps))) / 10_000n;
        const common = {
          poolComponent: hop.poolComponent,
          accountAddress,
          inputResource: hop.inputResource,
          outputResource: hop.outputResource,
          rawInputAmount: hop.amountIn,
          minOutput,
          maxEpoch,
          operationId: operationId(),
          quoteEvidence: { quotedOutput: hop.amountOut, feeBps: hop.feeBps, slippageBps, effectiveInput: String(effective) },
        };
        // The two templates' `swap` signatures are identical, so the instruction list is the
        // same; the intents differ in their operation name, which is what makes a review say
        // "transparent pool" rather than "public pool".
        return venues[0] === 'REVEALED' ? buildRevealedSwapIntent(common) : buildSwapIntent(common);
      }
      return buildMultiHopSwapIntent({
        accountAddress,
        rawInputAmount: quote.amountIn,
        hops: quote.hops.map((h, i) => ({
          poolComponent: h.poolComponent,
          inputResource: h.inputResource,
          outputResource: h.outputResource,
          quotedOutput: h.amountOut,
          feeBps: h.feeBps,
          ...(venues[i] === undefined ? {} : { venue: venues[i]! }),
        })),
        minOutput,
        maxEpoch,
        operationId: operationId(),
        slippageBps,
      });
    },
  };
}
