import { WalletAdapter, WalletSession, NetworkInfo, AccountInfo, Balance, ResourceInfo, TransactionPreview, TransactionResult } from './interface';
import { notImplemented, WalletAdapterNotImplementedError } from './not_implemented';

export { WalletAdapterNotImplementedError };

const refuse = notImplemented(
  'BrowserExtensionWalletAdapter',
  'This class is a declared placeholder for the historical extension interface. Use the Tari dApp provider bridge (apps/web) instead.',
);

/**
 * NOT IMPLEMENTED. Retained only for source compatibility with the historical
 * extension interface.
 *
 * Previously this returned a plausible session, the placeholder account
 * `extension-account-placeholder`, empty balances, and `pending` for every
 * transaction lookup — so it could be bound to and would look connected. Every
 * operation that could return financial or account state now refuses loudly.
 */
export class BrowserExtensionWalletAdapter implements WalletAdapter {
  adapterName(): string {
    return 'BrowserExtensionSigner(NOT_IMPLEMENTED)';
  }

  adapterType(): 'extension' {
    return 'extension';
  }

  /** Always `false`: a provider that cannot answer a capability handshake is not a provider. */
  async isSupported(): Promise<boolean> {
    return false;
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
