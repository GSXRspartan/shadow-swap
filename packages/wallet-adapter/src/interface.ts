export interface NetworkInfo {
  name: string;
  indexerUrls: string[];
  nativeResourceAddress: string | null;
}

export interface AccountInfo {
  address: string;
  accountIndex: number;
  label?: string;
}

export interface Balance {
  resourceAddress: string;
  amount: string; // decimal string for precision
  resourceType: 'fungible' | 'confidential' | 'stealth' | 'non_fungible';
  /**
   * DISPLAY ONLY. Raw units above stay exact and are never divided by this for
   * settlement math; it exists so a human-readable amount can be rendered.
   */
  divisibility?: number;
  /**
   * DISPLAY ONLY, and NEVER an identity.
   *
   * The asset-safety policy classifies a resource by its exact ADDRESS. A
   * symbol is a label an issuer picks, and any issuer can print `tTARI` on a
   * worthless token, so nothing that decides routing, eligibility or safety may
   * read this field.
   */
  symbol?: string;
}

export interface ResourceInfo {
  address: string;
  type: string;
  symbol?: string;
  decimals?: number;
}

export interface TransactionPreview {
  componentAddress?: string;
  method?: string;
  args: unknown[];
  resourcesInvolved: string[];
  estimatedOutputs: { resource: string; amount: string }[];
  fee: number; // basis points
  maxEpoch: number;
  privacyDisclosure: string;
  networkName: string;
}

export interface TransactionResult {
  transactionId: string;
  epoch: number;
  status: 'success' | 'rejected' | 'pending';
  error?: string;
}

export interface WalletSession {
  adapterType: 'extension' | 'mobile' | 'sapient' | 'walletd' | 'embedded';
  connectedAt: string;
  network: NetworkInfo;
  account: AccountInfo;
  supportedFeatures: string[];
  permissions: string[];
}

export interface WalletAdapter {
  adapterName(): string;
  adapterType(): 'extension' | 'mobile' | 'sapient' | 'walletd' | 'embedded';

  isSupported(): Promise<boolean>;

  connect(networkHint?: NetworkInfo): Promise<WalletSession>;

  disconnect(): Promise<void>;

  getNetwork(): Promise<NetworkInfo>;

  getAccounts(): Promise<AccountInfo[]>;

  getSelectedAccount(): Promise<AccountInfo>;

  getBalances(): Promise<Balance[]>;

  getResources(): Promise<ResourceInfo[]>;

  previewTransaction(preview: Partial<TransactionPreview>): Promise<TransactionPreview>;

  signAndSubmit(preview: TransactionPreview): Promise<TransactionResult>;

  getTransactionStatus(txId: string): Promise<{ status: string; epoch?: number; error?: string }>;
}

export interface AdapterFactory {
  name: string;
  create(): WalletAdapter;
}
