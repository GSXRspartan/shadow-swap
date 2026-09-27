/**
 * Cross-chain public subpath: `@tari-ootle/protocol-client/crosschain`.
 *
 * The cross-layer modules were previously only reachable through deep
 * `dist/...` paths, which bypasses the package `exports` map and therefore
 * bypasses the ESM/CJS resolution that the package contract now declares. That
 * is how a browser bundle ended up compiling a CommonJS file, and it is a
 * duplicate-module-instance hazard for anything branded at runtime (see
 * `multihop/proof.ts`).
 *
 * Importing through this subpath keeps the package contract authoritative.
 */
export * from './types.js';
export * from './quote.js';
export * from './provider.js';
export * from './secret.js';
export * from './session.js';
export * from './router.js';
export * from './reservation.js';
export * from './deadlines.js';
// `coordinator.ts` and `deadlines.ts` both export `DeadlineSafetyInput`. The
// deadlines module is the owner of the type; the coordinator's copy is a
// re-export for historical reasons, so the ambiguity is resolved explicitly
// rather than by a silent `export *` collision.
export {
  REAL_CROSSCHAIN_SUBMIT_ENV,
  isRealSubmitEnabled,
  CoordinatorRefusal,
  validateQuoteView,
  beginL1Funding,
  verifyL1Funded,
  beginL2Funding,
  verifyL2Funded,
  armClaim,
  revealAndClaimL2,
  claimL1,
  assessRefundEligibility,
  finalizeSession,
  recoverSession,
} from './coordinator.js';
export type { CoordinatorPorts, CrossChainQuoteView, AcceptQuoteRequest, LegFundOutcome, VerifyOutcome, RecoveryDecision } from './coordinator.js';
