/**
 * Reference wallet provider, installed into the page before any app script runs.
 *
 * This is TEST-ONLY. It exists so the security flows can drive a real browser
 * against a deterministic provider. It is never bundled: `addInitScript` runs
 * in the page context, and the file lives under `e2e/` rather than `src/`.
 *
 * It implements the PUBLISHED contract
 * (https://universe.tari.mw/integration/tari-dapp.d.ts), not a copy of one
 * wallet's bridge: `tari_getNetwork` resolves a string, the account methods
 * resolve `string[]` of component addresses, `tari_getBalances` returns the
 * documented `kind`/`divisibility` fields, `tari_getSubstate` is called with
 * `substateId`, `tari_signAndSubmitTransaction` receives `instructions`, and
 * `tari_disconnect` resolves `null`. A double that mirrored the old
 * reverse-engineered shapes would have let a non-conforming provider pass.
 *
 * It deliberately exposes controls an attacker would want, so the flows can
 * exercise the defences: `__tariHost.swapAccount`, `__tariHost.switchNetwork`,
 * `__tariHost.downgradeCapabilities`, `__tariHost.replaceProvider`,
 * `__tariHost.hang`, `__tariHost.failWithCode`, and `__tariHost.failWithoutCode`.
 * Each one models a real wallet behaviour the app must survive.
 */

export interface ReferenceProviderState {
  network: string;
  /** Account COMPONENT address, as `tari_requestAccounts` returns. */
  account: string;
  accounts: string[];
  /** The published `tari_getCapabilities` advertisement. */
  capabilities: Record<string, boolean>;
  balances: Array<{ resourceAddress: string; kind: string; symbol: string | null; name: string | null; divisibility: number; amount: string; confidentialAmount: string }>;
  /** When set, every request rejects with this message and NO numeric code. */
  failWith?: string;
  /** When set, every request rejects with this documented/numeric code. */
  failWithCode?: number;
  /** When true, no request ever resolves. */
  hang?: boolean;
  /** When set, the trio reports this transaction id instead of a real one. */
  claimSubmittedTxId?: string;
  /** When true, signing reports success without submitting anything. */
  lieAboutSubmission?: boolean;
}

/** The full published capability set, all enabled. */
const CAPABILITIES: Record<string, boolean> = {
  exactInputSelection: true,
  stealthWithdraw: true,
  stealthRedeem: true,
  stealthRedeemPrivateFee: true,
  htlcFund: true,
  scriptPathSpend: true,
  privateSpend: true,
  minimumValuePromise: true,
  ownershipProof: true,
  walletOwnershipProof: true,
  privateBalanceView: true,
  privateViewGranted: false,
  transactionResultLookup: true,
  transactionRequests: true,
  walletAddress: true,
  dryRunIsLocal: true,
};

export const DEFAULT_STATE: ReferenceProviderState = {
  network: 'esmeralda',
  account: 'component_account_A',
  accounts: ['component_account_A', 'component_account_B'],
  capabilities: { ...CAPABILITIES },
  // The wallet is the only source of a resource's SYMBOL and divisibility: the
  // indexer returns component state as raw tagged CBOR and cannot supply either.
  // Both pools' assets are listed here so both pairs can be described.
  balances: [
    { resourceAddress: 'otl_canonical_tari', kind: 'Fungible', symbol: 'TARI', name: 'Tari', divisibility: 6, amount: '10000000000', confidentialAmount: '0' },
    { resourceAddress: 'otl_wstable_0001', kind: 'Fungible', symbol: 'wSTABLE', name: 'Wrapped USDT', divisibility: 6, amount: '25000000000', confidentialAmount: '0' },
    { resourceAddress: 'otl_aaa_0001', kind: 'Fungible', symbol: 'AAA', name: 'AAA', divisibility: 6, amount: '40000000000', confidentialAmount: '0' },
    { resourceAddress: 'otl_bbb_0001', kind: 'Fungible', symbol: 'BBB', name: 'BBB', divisibility: 6, amount: '80000000000', confidentialAmount: '0' },
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
    failWithCode(code: number | undefined): void;
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

/**
 * The second pool, keyed by its own component address.
 *
 * `tari_getSubstate` answers per component because a wallet decodes the fields
 * of whichever substate was named. Answering every id with the same pool would
 * make a discovery layer that returned duplicate or wrong addresses look correct.
 */
export const SAFE_POOL = {
  poolComponent: 'component_pool_a_b_0002',
  baseResource: 'otl_aaa_0001',
  quoteResource: 'otl_bbb_0001',
  baseSymbol: 'AAA',
  quoteSymbol: 'BBB',
};

/** Decoded pool state, keyed by component address, as the wallet would report it. */
const POOL_FIELDS: Record<string, { resourceA: string; resourceB: string; feeBps: string; templateName: string }> = {
  [POOL.poolComponent]: { resourceA: POOL.baseResource, resourceB: POOL.quoteResource, feeBps: '30', templateName: 'Pool' },
  [SAFE_POOL.poolComponent]: { resourceA: SAFE_POOL.baseResource, resourceB: SAFE_POOL.quoteResource, feeBps: '5', templateName: 'Pool' },
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
    downgradeCapabilities() { state.capabilities.scriptPathSpend = false; state.capabilities.transactionRequests = false; },
    replaceProvider() { window.tari = makeProvider(); },
    hang() { state.hang = true; },
    unhang() { state.hang = false; },
    failWith(message) { state.failWith = message; },
    failWithCode(code) { state.failWithCode = code; },
    lieAboutSubmission(lie) { state.lieAboutSubmission = lie; },
    setClaimedTxId(txId) { state.claimSubmittedTxId = txId; },
  };
  function makeProvider() {
    const requests = [];
    return {
      isTariWallet: true,
      requests,
      async request(envelope) {
        if (state.hang) return new Promise(() => {});
        if (state.failWithCode !== undefined) {
          const error = new Error('provider failure');
          error.code = state.failWithCode;
          throw error;
        }
        if (state.failWith) throw new Error(state.failWith);
        requests.push(JSON.parse(JSON.stringify(envelope)));
        switch (envelope.method) {
          case 'tari_getNetwork':
            // The contract types this as Promise<string>.
            return state.network;
          case 'tari_getCapabilities':
            return { ...state.capabilities };
          case 'tari_requestAccounts':
          case 'tari_getAccounts':
            // The contract returns string[] of account component addresses.
            return [state.account];
          case 'tari_getWalletAddress':
            return 'otl_esm_1qqwalletaddress';
          case 'tari_getBalances':
            return state.balances;
          case 'tari_getSubstate':
            // The contract takes { substateId, version? }.
            // The fields are the COMPONENT's own, decoded from its state. The
            // indexer cannot supply them (it serves raw tagged CBOR), which is
            // why this is the authoritative side of the discovery/read split.
            {
              const substateId = envelope.params.substateId;
              const known = ${JSON.stringify(POOL_FIELDS)}[substateId];
              if (known === undefined) {
                // An unknown substate does not exist. Reporting it as absent is
                // what lets the app distinguish "not a pool" from "read failed".
                return { substateId, notFound: true, fields: {} };
              }
              return {
                substateId,
                templateName: known.templateName,
                substateVersion: '7',
                epoch: '900',
                fields: {
                  resource_a: known.resourceA,
                  resource_b: known.resourceB,
                  reserve_a: '1000000000',
                  reserve_b: '4000000000',
                  fee_bps: known.feeBps,
                  lp_resource: 'otl_lp_0001',
                  total_lp_supply: '2000000000',
                  locked_lp_supply: '0',
                },
              };
            }
          case 'tari_signAndSubmitTransaction':
            return { transactionId: state.claimSubmittedTxId || ('tx_' + Date.now().toString(36)), epoch: '900' };
          case 'tari_createTransactionRequest':
            return { requestId: 'req_' + Date.now().toString(36) };
          case 'tari_getTransactionRequest':
            return { requestId: envelope.params.requestId, status: 'approved', note: 'approved', createdAt: 1, expiresAt: 2 };
          case 'tari_submitTransactionRequest':
            return { transactionId: state.claimSubmittedTxId || ('tx_' + Date.now().toString(36)), epoch: '900' };
          case 'tari_getTransactionResult':
            return { transactionId: envelope.params.transactionId, status: 'UNKNOWN', epoch: '900' };
          case 'tari_disconnect':
            // The contract types this as Promise<null>.
            return null;
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
