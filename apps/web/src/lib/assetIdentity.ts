/**
 * Resource identity presentation.
 *
 * A symbol is a LABEL, never an identity. Two different `ResourceAddress`
 * values can carry the same symbol, and the UI must keep them distinguishable.
 * Every asset chip therefore renders the human label with the exact address
 * reachable behind a detail affordance, and the address is what gets copied,
 * compared, and routed.
 */

import { classifyResourceForRouting, type ResourceFactsForRouting, type ResourceRoutingClass, type AssetSafetyClass } from '@tari-ootle/protocol-client';
import { formatAddress, formatUnits, UNAVAILABLE } from './format.js';
import { safeLabel } from './sanitize.js';

export interface AssetDescriptor {
  /** EXACT ResourceAddress. The identity. Never optional. */
  resourceAddress: string;
  /** Display symbol. Untrusted; sanitised before rendering. */
  symbol?: string;
  decimals: string;
  /** Classification from the protocol client, never invented here. */
  safetyClass: ResourceRoutingClass;
}

export interface AssetChip {
  resourceAddress: string;
  symbol: string;
  decimals: string;
  safetyClass: ResourceRoutingClass;
  /** Abbreviated address for the chip face. */
  shortAddress: string;
  /** Full address for the detail popover / copy target. */
  fullAddress: string;
  /** Whether the label is trustworthy enough to show at all. */
  hasSymbol: boolean;
}

export function toAssetChip(descriptor: AssetDescriptor): AssetChip {
  const symbol = safeLabel(descriptor.symbol, 16);
  return {
    resourceAddress: descriptor.resourceAddress,
    symbol: symbol === '' ? 'Unnamed' : symbol,
    decimals: descriptor.decimals,
    safetyClass: descriptor.safetyClass,
    shortAddress: formatAddress(descriptor.resourceAddress, 6, 4),
    fullAddress: descriptor.resourceAddress,
    hasSymbol: symbol !== '',
  };
}

/**
 * Classification is delegated to the protocol-client so the browser can never
 * present a different verdict than the execution layer would apply.
 */
export function classifyAsset(facts: ResourceFactsForRouting): ResourceRoutingClass {
  return classifyResourceForRouting(facts);
}

export interface SafetyPresentation {
  label: string;
  /** Short explanation shown in the chip's title and the detail panel. */
  explanation: string;
  /** Whether an explicit user acknowledgement is required by routing policy. */
  requiresAcknowledgement: boolean;
  /** Whether the UI must warn. */
  warn: boolean;
  /** Whether a chart/metric existing implies vetting. It never does. */
  severity: 'ok' | 'info' | 'warn' | 'danger';
}

const SAFETY_PRESENTATION: Record<ResourceRoutingClass, SafetyPresentation> = {
  CANONICAL_TARI: {
    label: 'Canonical TARI',
    explanation: 'Identified as the canonical TARI resource by exact address. The native settlement asset of the Ootle layer 2.',
    requiresAcknowledgement: false,
    warn: false,
    severity: 'ok',
  },
  PUBLIC_IMMUTABLE_OR_VETTED: {
    label: 'Public / immutable',
    explanation: 'A public fungible resource whose issuer authority over recall, freeze, and rule changes was not observed. The absence of a warning is not a guarantee.',
    requiresAcknowledgement: false,
    warn: false,
    severity: 'info',
  },
  ISSUER_CONTROLLED: {
    label: 'Issuer controlled',
    explanation:
      'The issuer can recall, freeze, or change this resource after you have pooled it. Balances and pool positions can lose value or access without warning.',
    requiresAcknowledgement: true,
    warn: true,
    severity: 'warn',
  },
  UNKNOWN: {
    label: 'Unclassified',
    explanation: 'Issuer authority was never inspected for this resource, so its safety class is unknown. Treat it as unvetted.',
    requiresAcknowledgement: true,
    warn: true,
    severity: 'warn',
  },
  UNSUPPORTED: {
    label: 'Unsupported',
    explanation: 'This resource type cannot be routed through a public fungible pool.',
    requiresAcknowledgement: false,
    warn: true,
    severity: 'danger',
  },
};

export function presentSafety(routingClass: ResourceRoutingClass): SafetyPresentation {
  return SAFETY_PRESENTATION[routingClass];
}

/** Map the market-data pair-level class onto the routing vocabulary. */
export function safetyFromPairClass(pairClass: AssetSafetyClass): ResourceRoutingClass {
  switch (pairClass) {
    case 'CANONICAL_TARI':
      return 'CANONICAL_TARI';
    case 'PUBLIC_IMMUTABLE_OR_VETTED':
      return 'PUBLIC_IMMUTABLE_OR_VETTED';
    case 'ISSUER_CONTROLLED':
      return 'ISSUER_CONTROLLED';
    case 'UNKNOWN':
    default:
      return 'UNKNOWN';
  }
}

export interface PoolIdentityChip {
  poolComponent: string;
  poolLabel: string;
  base: AssetChip;
  quote: AssetChip;
  /** Which side carries the weaker classification, if any. */
  weakest: ResourceRoutingClass;
  requiresAcknowledgement: boolean;
}

const ROUTING_SEVERITY_ORDER: Record<ResourceRoutingClass, number> = {
  CANONICAL_TARI: 0,
  PUBLIC_IMMUTABLE_OR_VETTED: 1,
  UNKNOWN: 2,
  ISSUER_CONTROLLED: 3,
  UNSUPPORTED: 4,
};

export function weakestClassification(...classes: ResourceRoutingClass[]): ResourceRoutingClass {
  return classes.reduce<ResourceRoutingClass>((worst, current) => (ROUTING_SEVERITY_ORDER[current] > ROUTING_SEVERITY_ORDER[worst] ? current : worst), 'CANONICAL_TARI');
}

export function buildPoolIdentity(input: {
  poolComponent: string;
  base: AssetDescriptor;
  quote: AssetDescriptor;
}): PoolIdentityChip {
  const base = toAssetChip(input.base);
  const quote = toAssetChip(input.quote);
  const weakest = weakestClassification(base.safetyClass, quote.safetyClass);
  return {
    poolComponent: input.poolComponent,
    poolLabel: `${base.symbol} / ${quote.symbol}`,
    base,
    quote,
    weakest,
    requiresAcknowledgement: SAFETY_PRESENTATION[weakest].requiresAcknowledgement,
  };
}

/** `12.34 TARI` with an exact address attached. */
export function describeAmount(raw: string | undefined, chip: AssetChip, options?: { abbreviate?: boolean; maxFractionDigits?: number }): string {
  const amount = formatUnits(raw, chip.decimals, options);
  if (amount === UNAVAILABLE) return UNAVAILABLE;
  return `${amount} ${chip.symbol}`;
}
