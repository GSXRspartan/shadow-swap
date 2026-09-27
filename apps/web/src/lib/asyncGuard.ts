/**
 * ASYNC RACE GUARD (mission §40, §41, §42).
 *
 * React effects and event handlers start promises that resolve later. A slow
 * quote for pool A can land after the user has navigated to pool B and overwrite
 * B's chart, quote, and resource identity — including the *action button* that a
 * stale NFT resolver result would enable.
 *
 * The guard is a monotonically increasing version per logical slot. A result may
 * only commit if its version is still the newest issued for that slot. It is
 * deliberately framework-free so it can be tested without a DOM, and it is
 * silent on a stale result: a superseded promise is a normal occurrence, not an
 * error worth surfacing to a user.
 */
export class VersionGuard {
  private readonly versions = new Map<string, number>();

  /** Issue a new version for a slot and return it. Call before starting work. */
  begin(slot: string): number {
    const next = (this.versions.get(slot) ?? 0) + 1;
    this.versions.set(slot, next);
    return next;
  }

  /** The newest version issued for a slot, or 0. */
  current(slot: string): number {
    return this.versions.get(slot) ?? 0;
  }

  /** True only if `version` is still the newest for `slot`. */
  isCurrent(slot: string, version: number): boolean {
    return this.current(slot) === version;
  }

  /**
   * Run `work`, and invoke `commit` only if no newer version was issued while it
   * was in flight. Returns whether the result was committed, so a caller can
   * distinguish "superseded" from "applied".
   */
  async run<T>(slot: string, work: () => Promise<T>, commit: (value: T) => void): Promise<{ committed: boolean; value?: T }> {
    const version = this.begin(slot);
    const value = await work();
    if (!this.isCurrent(slot, version)) return { committed: false, value };
    commit(value);
    return { committed: true, value };
  }

  /**
   * Discard every in-flight version for a slot, so nothing that is already
   * pending can commit. Used on unmount and on identity change.
   */
  invalidate(slot: string): void {
    this.versions.set(slot, this.current(slot) + 1);
  }

  /** True when nothing is outstanding for a slot. */
  isIdle(slot: string): boolean {
    return !this.versions.has(slot);
  }
}

/** Canonical slot names, so a typo cannot silently disable a guard. */
export const SLOTS = {
  poolQuotes: 'pool:quote',
  poolCandles: 'pool:candles',
  poolTrades: 'pool:trades',
  poolHeader: 'pool:header',
  nftListing: 'nft:listing',
  nftCollection: 'nft:collection',
  walletBalances: 'wallet:balances',
  walletNetwork: 'wallet:network',
  walletCapabilities: 'wallet:capabilities',
  historyList: 'history:list',
} as const;

export type SlotName = (typeof SLOTS)[keyof typeof SLOTS];
