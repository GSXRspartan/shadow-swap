import { WalletAdapter, WalletSession, NetworkInfo, AccountInfo, Balance, ResourceInfo, TransactionPreview, TransactionResult } from './interface';
import { notImplemented, WalletAdapterNotImplementedError } from './not_implemented';

export { WalletAdapterNotImplementedError };

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const refuse = notImplemented(
  'EmbeddedOotleWalletAdapter',
  'No embedded wallet SDK is wired in this build, and none should be: an embedded wallet would require key material to live in the page. ' +
    'Use a non-custodial provider instead.',
);

/**
 * NOT IMPLEMENTED. Retained for source compatibility only.
 *
 * The previous implementation had two distinct problems:
 *   - it read a seed-entropy value from the injected key-value store
 *     (`ootle_seed_entropy`) and fell back to the literal string
 *     `test-entropy-placeholder`. A `KeyValueStore` is typically
 *     `localStorage`, so this established a pattern of putting key material in
 *     browser storage. That is refused outright, not merely unused.
 *   - `signAndSubmit()` returned `tx-embedded-<timestamp>` without submitting
 *     anything, leaving the operation permanently SUBMITTED.
 *
 * The store is retained in the constructor only so existing call sites keep
 * compiling; it is never read or written.
 */
export class EmbeddedOotleWalletAdapter implements WalletAdapter {
  private readonly store: KeyValueStore | undefined;

  constructor(store?: KeyValueStore) {
    this.store = store;
  }

  adapterName(): string {
    return 'EmbeddedOotleWallet(NOT_IMPLEMENTED)';
  }

  adapterType(): 'embedded' {
    return 'embedded';
  }

  /** Always `false`. An embedded wallet would be custodial by construction. */
  async isSupported(): Promise<boolean> {
    return false;
  }

  /** Whether a key-value store was supplied. Diagnostic only; never used. */
  hasStore(): boolean {
    return this.store !== undefined;
  }

  async connect(_networkHint?: NetworkInfo): Promise<WalletSession> {
    return refuse('connect');
  }

  async disconnect(): Promise<void> {
    // Disconnecting something that was never connected is a no-op, not a failure.
  }

  async getNetwork(): Promise<NetworkInfo> {
    return refuse('getNetwork');
  }

  async getAccounts(): Promise<AccountInfo[]> {
    return refuse('getAccounts');
  }

  async getSelectedAccount(): Promise<AccountInfo> {
    return refuse('getSelectedAccount');
  }

  async getBalances(): Promise<Balance[]> {
    return refuse('getBalances');
  }

  async getResources(): Promise<ResourceInfo[]> {
    return refuse('getResources');
  }

  async previewTransaction(_preview: Partial<TransactionPreview>): Promise<TransactionPreview> {
    return refuse('previewTransaction');
  }

  async signAndSubmit(_preview: TransactionPreview): Promise<TransactionResult> {
    return refuse('signAndSubmit');
  }

  async getTransactionStatus(_txId: string): Promise<{ status: string; epoch?: number; error?: string }> {
    return refuse('getTransactionStatus');
  }
}
