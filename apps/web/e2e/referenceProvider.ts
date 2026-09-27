/**
 * Reference wallet provider, installed into the page before any app script runs.
 *
 * This is TEST-ONLY. It exists so the security flows can drive a real browser
 * against a deterministic provider. It is never bundled: `addInitScript` runs
 * in the page context, and the file lives under `e2e/` rather than `src/`.
 *
 * It deliberately exposes controls an attacker would want, so the flows can
 * exercise the defences: `__tariHost.swapAccount`, `__tariHost.switchNetwork`,
 * `__tariHost.downgradeCapabilities`, `__tariHost.replaceProvider`, and
 * `__tariHost.hang`. Each one models a real wallet behaviour the app must
 * survive.
 */

export interface ReferenceProviderState {
  network: string;
  account: string;
  accounts: string[];
  capabilities: Record<string, boolean>;
  balances: Array<{ resourceAddress: string; amount: string; resourceType: string }>;
  /** When set, every request rejects with this message. */
  failWith?: string;
  /** When true, no request ever resolves. */
  hang?: boolean;
  /** When set, signAndSubmit reports this transaction id instead of a real one. */
  claimSubmittedTxId?: string;
  /** When true, signAndSubmit reports success without submitting anything. */
  lieAboutSubmission?: boolean;
}

export const DEFAULT_STATE: ReferenceProviderState = {
  network: 'esmeralda',
  account: 'otl_account_A',
  accounts: ['otl_account_A', 'otl_account_B'],
  capabilities: {
    l1Balance: true,
    l1NormalSend: true,
    l1ShaInit: false,
    l1ShaInspect: false,
    l1ShaClaim: false,
    l1ShaRefund: false,
    l2HtlcFund: true,
    l2HtlcClaim: true,
    l2HtlcRefund: true,
  },
  balances: [
    { resourceAddress: 'otl_canonical_tari', amount: '10000000000', resourceType: 'fungible' },
    { resourceAddress: 'otl_wstable_0001', amount: '25000000000', resourceType: 'fungible' },
  ],
};

declare global {
  interface TariHost {
    state: ReferenceProviderState;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    swapAccount(): void;
    switchNetwork(network: string): void;
    downgradeCapabilities(): void;
    replaceProvider(): void;
    hang(): void;
    unhang(): void;
    failWith(message: string | undefined): void;
    lieAboutSubmission(lie: boolean): void;
    setClaimedTxId(txId: string | undefined): void;
  }
  interface Window {
    tari?: unknown;
    __tariHost?: TariHost;
  }
}

export const POOL = {
  poolComponent: 'component_pool_tari_wstable_0001',
  baseResource: 'otl_canonical_tari',
  quoteResource: 'otl_wstable_0001',
  baseSymbol: 'TARI',
  quoteSymbol: 'wSTABLE',
};

/** The init script, as a string, so it can be passed to `page.addInitScript`. */
export const installReferenceProvider = `
(() => {
  const state = ${JSON.stringify(DEFAULT_STATE)};
  const host = {
    state,
    swapAccount() {
      const i = state.accounts.indexOf(state.account);
      state.account = state.accounts[(i + 1) % state.accounts.length];
    },
    switchNetwork(network) { state.network = network; },
    downgradeCapabilities() { state.capabilities.l2HtlcFund = false; state.capabilities.l2HtlcClaim = false; },
    replaceProvider() { window.tari = makeProvider(); },
    hang() { state.hang = true; },
    unhang() { state.hang = false; },
    failWith(message) { state.failWith = message; },
    lieAboutSubmission(lie) { state.lieAboutSubmission = lie; },
    setClaimedTxId(txId) { state.claimSubmittedTxId = txId; },
  };
  function makeProvider() {
    return {
      async request(envelope) {
        if (state.hang) return new Promise(() => {});
        if (state.failWith) throw new Error(state.failWith);
        switch (envelope.method) {
          case 'tari_getNetwork':
            return { network: state.network, epoch: '900' };
          case 'tari_getCapabilities':
            return { ...state.capabilities };
          case 'tari_requestAccounts':
          case 'tari_getAccounts':
            return [{ componentAddress: state.account, walletAddress: 'otl_wallet_' + state.account }];
          case 'tari_getBalances':
            return state.balances;
          case 'tari_getSubstate':
            return {
              address: envelope.params && envelope.params.address,
              templateName: 'Pool',
              substateVersion: '7',
              epoch: '900',
              fields: {
                resource_a: ${JSON.stringify(POOL.baseResource)},
                resource_b: ${JSON.stringify(POOL.quoteResource)},
                reserve_a: '1000000000',
                reserve_b: '4000000000',
                fee_bps: '30',
                lp_resource: 'otl_lp_0001',
                total_lp_supply: '2000000000',
                locked_lp_supply: '0',
              },
            };
          case 'tari_signAndSubmitTransaction':
            return {
              transactionId: state.claimSubmittedTxId || ('tx_' + Date.now().toString(36)),
              epoch: '900',
            };
          case 'tari_getTransactionResult':
            return { transactionId: envelope.params.transactionId, status: 'UNKNOWN', epoch: '900' };
          case 'tari_disconnect':
            return { ok: true };
          default:
            throw new Error('unsupported method ' + envelope.method);
        }
      },
    };
  }
  window.tari = makeProvider();
  window.__tariHost = Object.assign(host, { connect: async () => {}, disconnect: async () => {} });
})();
`;
