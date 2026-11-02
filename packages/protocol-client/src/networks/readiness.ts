/**
 * Mainnet readiness: real, verifiable states, and real-money execution gated behind the last one.
 *
 * WHY THIS IS A STATE MACHINE AND NOT A BOOLEAN
 *
 * "Is mainnet supported?" has no useful answer. A build can know mainnet's identity, read its
 * market data, and still have no published contracts — and each of those is a different thing to
 * tell a user and a different thing to work on next. A single flag collapses them, and the
 * collapse always resolves in the optimistic direction, because a flag that is off looks like a
 * bug and someone turns it on.
 *
 * So readiness is a LADDER, each rung requires EVIDENCE, and the rung that permits spending money
 * requires a human decision that no other rung can imply:
 *
 *   1. `NETWORK_UNKNOWN`        this build has no verified facts about the network.
 *   2. `NETWORK_CONFIGURED`     identity known, endpoints known (possibly none).
 *   3. `CHAIN_REACHABLE`        an endpoint answered and its identity matched.
 *   4. `WALLET_COMPATIBLE`      a wallet is connected and reports the same network.
 *   5. `CONTRACTS_VERIFIED`     a manifest validated against the live chain, with templates.
 *   6. `MARKET_DATA_READY`      read-only discovery works: pools and assets can be listed.
 *   7. `TRADING_AUTHORIZED`     the operator has explicitly authorized real-money execution.
 *
 * `canExecute` is true at exactly one rung. Nothing else in this codebase may decide that
 * question, and nothing about a calendar date, a build flag or a successful read advances it.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No automatic activation. No scheduled enablement. No "mainnet is unsupported" hardcoding
 * either — a build that permanently refuses mainnet cannot be made ready, which is its own kind
 * of dishonesty once the operator does intend to launch. The gate is the authorization, not the
 * network's name.
 */

import { type TariNetwork, isTestnet } from './chainIdentity.js';
import { type DeploymentFeature, type DeploymentManifest, featureAvailability } from './manifest.js';
import { type Layer, profileFor } from './registry.js';

export type ReadinessStage =
  | 'NETWORK_UNKNOWN'
  | 'NETWORK_CONFIGURED'
  | 'CHAIN_REACHABLE'
  | 'WALLET_COMPATIBLE'
  | 'CONTRACTS_VERIFIED'
  | 'MARKET_DATA_READY'
  | 'TRADING_AUTHORIZED';

/** Weakest to strongest, so a UI can render progress and a test can assert monotonicity. */
export const READINESS_STAGES: readonly ReadinessStage[] = [
  'NETWORK_UNKNOWN',
  'NETWORK_CONFIGURED',
  'CHAIN_REACHABLE',
  'WALLET_COMPATIBLE',
  'CONTRACTS_VERIFIED',
  'MARKET_DATA_READY',
  'TRADING_AUTHORIZED',
];

/**
 * The evidence a stage is computed from. Every field is something OBSERVED, and the one field
 * that is a decision rather than an observation is named so it cannot be mistaken for one.
 */
export interface ReadinessEvidence {
  readonly layer: Layer;
  readonly network: TariNetwork;
  /** An endpoint answered and its reported identity matched what was expected. */
  readonly chainIdentityVerified: boolean;
  /** A wallet is connected AND reports this same network. */
  readonly walletNetwork?: TariNetwork;
  /** A manifest that passed `validateManifest` against the live chain. */
  readonly manifest?: DeploymentManifest;
  /** Read-only discovery returned a usable result. */
  readonly marketDataAvailable: boolean;
  /**
   * EXPLICIT OPERATOR AUTHORIZATION for real-money execution on this network.
   *
   * Not a build flag, not an environment variable that defaults on, and not implied by any other
   * field. A caller passes `true` here only because a person decided it for this network.
   */
  readonly tradingAuthorized: boolean;
}

export interface ReadinessVerdict {
  readonly stage: ReadinessStage;
  /** True at `TRADING_AUTHORIZED` and nowhere else. */
  readonly canExecute: boolean;
  /** Read-only use is permitted from `CHAIN_REACHABLE` upwards. */
  readonly canRead: boolean;
  /** What is missing to reach the next rung. Empty only at the top. */
  readonly blockers: readonly string[];
  /** One line for a UI, stating the evidence rather than implying more than exists. */
  readonly summary: string;
  /** True when this network carries real value, whatever the stage. */
  readonly realValue: boolean;
}

/**
 * Computes the stage from evidence.
 *
 * Each rung is gated on the one below, so a later piece of evidence cannot skip a missing earlier
 * one: a validated manifest with no reachable chain is not `CONTRACTS_VERIFIED`, because the
 * validation had nothing to validate against.
 */
export function assessReadiness(evidence: ReadinessEvidence): ReadinessVerdict {
  const realValue = !isTestnet(evidence.network);
  const blockers: string[] = [];

  const lookup = profileFor(evidence.layer, evidence.network);
  if (!lookup.ok) {
    return {
      stage: 'NETWORK_UNKNOWN',
      canExecute: false,
      canRead: false,
      blockers: [lookup.reason],
      summary: lookup.reason,
      realValue,
    };
  }
  const profile = lookup.profile;

  let stage: ReadinessStage = 'NETWORK_CONFIGURED';
  if (profile.endpoints.length === 0) {
    blockers.push(
      profile.endpointReason ??
        `No endpoint is configured for ${profile.displayName}, so nothing can be read from it.`,
    );
  }
  if (!profile.launched) blockers.push(profile.launchNote);

  if (evidence.chainIdentityVerified && profile.endpoints.length > 0) {
    stage = 'CHAIN_REACHABLE';
  } else if (profile.endpoints.length > 0) {
    blockers.push(`No endpoint for ${profile.displayName} has answered with a matching chain identity in this session.`);
  }

  if (stage === 'CHAIN_REACHABLE') {
    if (evidence.walletNetwork === undefined) {
      blockers.push('No wallet is connected, so no account can sign or be read authoritatively.');
    } else if (evidence.walletNetwork !== evidence.network) {
      blockers.push(
        `The connected wallet reports ${evidence.walletNetwork} and this build is configured for ${evidence.network}. A transaction built for one network and signed on another is rejected at best and misdirected at worst.`,
      );
    } else {
      stage = 'WALLET_COMPATIBLE';
    }
  }

  if (stage === 'WALLET_COMPATIBLE') {
    const manifest = evidence.manifest;
    if (manifest === undefined) {
      blockers.push('No deployment manifest has been validated against the live chain, so no template is trusted.');
    } else if (manifest.network !== evidence.network) {
      blockers.push(`The validated manifest is for ${manifest.network}, not ${evidence.network}.`);
    } else {
      const anyFeature = Object.values(manifest.templates).some((list) => (list?.length ?? 0) > 0);
      if (!anyFeature) {
        blockers.push(`The manifest for ${manifest.network} generation ${manifest.generation} records no templates, so no contract is published here yet.`);
      } else {
        stage = 'CONTRACTS_VERIFIED';
      }
    }
  }

  if (stage === 'CONTRACTS_VERIFIED') {
    if (evidence.marketDataAvailable) stage = 'MARKET_DATA_READY';
    else blockers.push('Read-only discovery has not returned a usable result yet, so there is nothing to show or price against.');
  }

  if (stage === 'MARKET_DATA_READY') {
    if (evidence.tradingAuthorized) stage = 'TRADING_AUTHORIZED';
    else {
      blockers.push(
        realValue
          ? 'Real-money execution on this network has not been authorized. Everything above is verified; this is the deliberate last step, and it is a decision rather than a check.'
          : 'Execution on this network has not been authorized in this build.',
      );
    }
  }

  // NETWORK_UNKNOWN returned early above, so the only non-readable stage left is
  // NETWORK_CONFIGURED: identity known, nothing read.
  const canRead = stage !== 'NETWORK_CONFIGURED';
  return {
    stage,
    canExecute: stage === 'TRADING_AUTHORIZED',
    canRead,
    blockers,
    summary: describeStage(stage, profile.displayName, realValue),
    realValue,
  };
}

function describeStage(stage: ReadinessStage, displayName: string, realValue: boolean): string {
  const value = realValue ? ' This network carries real value.' : '';
  switch (stage) {
    case 'NETWORK_UNKNOWN':
      return `${displayName} is not a network this build has verified facts about.${value}`;
    case 'NETWORK_CONFIGURED':
      return `${displayName} is configured — its identity is known — but nothing has been read from it in this session.${value}`;
    case 'CHAIN_REACHABLE':
      return `${displayName} answered and its chain identity matched. No wallet is connected yet.${value}`;
    case 'WALLET_COMPATIBLE':
      return `${displayName} is reachable and a wallet on the same network is connected. No contracts are verified here yet.${value}`;
    case 'CONTRACTS_VERIFIED':
      return `${displayName} has verified contracts for at least one feature. Market data is not loaded yet.${value}`;
    case 'MARKET_DATA_READY':
      return `${displayName} is readable end to end: contracts verified and market data loading. Execution is NOT enabled.${value}`;
    case 'TRADING_AUTHORIZED':
      return `${displayName} is authorized for execution.${value}`;
    default:
      return `${displayName}: unknown readiness stage.`;
  }
}

/**
 * Whether one specific economic operation may be built right now.
 *
 * Two separate questions, deliberately both required: is execution authorized on this network at
 * all, and is the feature this operation needs actually deployed. A caller that checks only the
 * first will happily build a call to a template that does not exist.
 */
export function canExecuteFeature(
  verdict: ReadinessVerdict,
  manifest: DeploymentManifest | undefined,
  feature: DeploymentFeature,
): { readonly ok: boolean; readonly reason: string } {
  if (!verdict.canExecute) {
    return { ok: false, reason: verdict.blockers[0] ?? verdict.summary };
  }
  const availability = featureAvailability(manifest, feature);
  if (!availability.available) return { ok: false, reason: availability.reason };
  return { ok: true, reason: `${feature} is deployed and execution is authorized on this network.` };
}

/**
 * The readiness ladder as rows a UI or a checklist can render, with each rung's own evidence
 * requirement stated. Used by the mainnet checklist document and the readiness panel so the two
 * cannot drift.
 */
export const READINESS_REQUIREMENTS: readonly { readonly stage: ReadinessStage; readonly requires: string }[] = [
  { stage: 'NETWORK_CONFIGURED', requires: 'A profile in the network registry: identity, byte, address form, fee model and finality model.' },
  { stage: 'CHAIN_REACHABLE', requires: 'An endpoint that answered, whose reported network and network byte matched what was expected.' },
  { stage: 'WALLET_COMPATIBLE', requires: 'A connected wallet reporting the SAME network as the build.' },
  { stage: 'CONTRACTS_VERIFIED', requires: 'A deployment manifest that passed validation against the live chain identity and generation, recording at least one template.' },
  { stage: 'MARKET_DATA_READY', requires: 'Read-only discovery returning a usable result.' },
  { stage: 'TRADING_AUTHORIZED', requires: 'Explicit operator authorization for this network. Not a date, not a build flag, not implied by any check above.' },
];
