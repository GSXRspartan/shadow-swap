import { WalletAdapter, WalletSession, NetworkInfo, AccountInfo, Balance, ResourceInfo, TransactionPreview, TransactionResult } from './interface';
import { notImplemented, WalletAdapterNotImplementedError } from './not_implemented';

export { WalletAdapterNotImplementedError };

const refuse = notImplemented(
  'WalletDaemonAdapter',
  'No walletd JSON-RPC transport is implemented in this build. ' +
    'There is deliberately NO default endpoint: the previous default of http://localhost:5100/json_rpc was a hard-coded localhost dependency that a production build would silently dial.',
);

/**
 * NOT IMPLEMENTED. Retained for source compatibility only.
 *
 * The previous implementation was actively dangerous:
 *   - it defaulted to a `http://localhost:5100/json_rpc` endpoint, so a
 *     production build dialled localhost with no operator opt-in;
 *   - `connect()` returned a session with the fabricated address
 *     `walletd-account` WITHOUT calling the daemon at all;
 *   - `signAndSubmit()` returned `tx-walletd-<timestamp>` without submitting
 *     anything, so the execution layer would persist SUBMITTED for an id that
 *     can never be resolved.
 */
export class WalletDaemonAdapter implements WalletAdapter {
  private readonly daemonUrl: string | undefined;

  /**
   * The endpoint is accepted only so callers keep compiling, and is never
   * dialled. There is no default: a localhost endpoint must be an explicit,
   * development-only, operator-supplied decision.
   */
  constructor(daemonUrl?: string) {
    this.daemonUrl = daemonUrl;
  }

  adapterName(): string {
    return 'WalletDaemonSigner(NOT_IMPLEMENTED)';
  }

  adapterType(): 'walletd' {
    return 'walletd';
  }

  /** Always `false`. No transport exists, so there is nothing to probe. */
  async isSupported(): Promise<boolean> {
    return false;
  }

  /** The configured endpoint, for diagnostics only. Never dialled. */
  describeEndpoint(): string {
    return this.daemonUrl === undefined ? 'none configured' : this.daemonUrl;
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
