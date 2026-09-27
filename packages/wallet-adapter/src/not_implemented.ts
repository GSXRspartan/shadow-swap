/**
 * Shared refusal for adapters that are interface placeholders rather than
 * implementations.
 *
 * A stub that answers a financial interface with fabricated state is worse than
 * one that refuses:
 *
 *   - `connect()` returning a session makes "connected" true for a wallet that
 *     does not exist, so the UI shows a balance and an account that are fiction;
 *   - `signAndSubmit()` returning a synthesised transaction id is a
 *     fund-loss-adjacent lie: the execution layer persists the operation as
 *     SUBMITTED, and because the id resolves to nothing it stays SUBMITTED
 *     forever — never confirmed, never failed, never reconciled;
 *   - `getTransactionStatus()` returning `pending` for every id makes a caller
 *     poll indefinitely instead of failing;
 *   - `isSupported()` returning `true` lets a caller bind to a provider that
 *     cannot answer anything.
 *
 * Every placeholder adapter therefore reports `false` from `isSupported()` and
 * throws from every other operation.
 */

/** Error raised by an adapter that is a declared placeholder. */
export class WalletAdapterNotImplementedError extends Error {
  constructor(adapter: string, operation: string, guidance: string) {
    super(
      `${adapter}.${operation} is NOT IMPLEMENTED. ${guidance} ` +
        'A placeholder adapter must never return account, balance, or transaction state: a fabricated "submitted" receipt would leave the operation ' +
        'permanently SUBMITTED, because the invented id resolves to nothing and can never be confirmed, failed, or reconciled.',
    );
    this.name = 'WalletAdapterNotImplementedError';
  }
}

/**
 * Build the thrower for one adapter, so every refusal message names the
 * adapter and the operation the caller actually invoked.
 */
export function notImplemented(adapter: string, guidance: string): (operation: string) => never {
  return (operation: string) => {
    throw new WalletAdapterNotImplementedError(adapter, operation, guidance);
  };
}
