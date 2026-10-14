// Live NFT marketplace operations against the published Esmeralda marketplace templates.
//
// WHAT THIS IS, AND WHAT IT IS NOT.
//
// The three marketplace templates are already PUBLISHED on Esmeralda:
//   FixedPriceListing  template_612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329
//   ItemOffer          template_083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6
//   CollectionBid      template_999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54
// This module NEVER publishes a template. It only drives them.
//
// It talks to a LOOPBACK wallet daemon over JSON-RPC and submits human-readable Tari
// MANIFESTS. The daemon signs with the account key it holds. No private key is ever
// seen, derived, exported or reconstructed by this tool.
//
// SAFETY MODEL (inherited from WalletdExecutor, plus marketplace-specific binding):
//   - loopback only; esmeralda testnet only (byte 38). Never mainnet.
//   - every mutation DRY-RUNS first; a dry run that did not Accept is never submitted;
//   - an explicit per-transaction fee ceiling AND an explicit account binding are both
//     required before a submission;
//   - the ACTING ACCOUNT is verified against the daemon's default account immediately
//     before signing, because the templates bind `cancel` to the TRANSACTION SIGNER;
//   - transaction identity is persisted to the durable ledger before the result is
//     trusted, so an interrupted run reconciles instead of blind-retrying;
//   - cumulative fees for this tool are capped across the whole process lifetime.
//
// There is no blind retry anywhere: an UNKNOWN outcome is reported as UNKNOWN and
// reconciled by an explicit reread, never resubmitted.
//
// Testnet only. No mainnet. No key export. No L1. No cross-chain.

import { WalletdExecutor, ExecutorError } from './walletd.mjs';

/**
 * The authoritative marketplace decoders from protocol-client, loaded from its built ESM
 * output exactly like `read-pool-live.mjs` loads `decodePoolState`. These read COMPONENT
 * STATE, which is the supported readback path since v0.46.0 retired template return values.
 */
const { decodeListing, decodeItemOffer, decodeCollectionBid } = await import(
  '../../packages/protocol-client/dist/esm/marketplaceSubstate.js'
);

/** Dispatch to the decoder for `kind`. Any decode failure propagates: the caller reports UNAVAILABLE. */
function decodeMarketplaceFacts(kind, reader, componentAddress, templateAddress) {
  switch (kind) {
    case 'FixedPriceListing':
      return decodeListing(reader, componentAddress, templateAddress);
    case 'ItemOffer':
      return decodeItemOffer(reader, componentAddress, templateAddress);
    case 'CollectionBid':
      return decodeCollectionBid(reader, componentAddress, templateAddress);
    default:
      throw new ExecutorError(`no marketplace decoder for ${kind}`);
  }
}

/**
 * Hard live fee budget for one process lifetime, from the run's fee limits:
 *   total new fees      <= 10 tTARI  (10_000_000 micro-tTARI)
 *   max single tx fee   <=  2 tTARI  ( 2_000_000 micro-tTARI)
 *   marketplace prices  =   tiny test values only
 */
export const FEE_BUDGET_TOTAL_MICRO = 10_000_000;
export const MAX_FEE_PER_MARKETPLACE_TX_MICRO = 2_000_000;

/**
 * The three already-published marketplace template addresses. These are identities,
 * not choices: the tool refuses anything else rather than driving a template that has
 * not been through this audit.
 */
export const MARKETPLACE_TEMPLATES = Object.freeze({
  FixedPriceListing: '612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329',
  ItemOffer: '083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6',
  CollectionBid: '999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54',
});

/** The getter each template exposes for an authoritative, non-mutable readback. */
export const MARKETPLACE_GETTERS = Object.freeze({
  FixedPriceListing: 'listing',
  ItemOffer: 'offer',
  CollectionBid: 'bid',
});

/** Status vocabularies, in the templates' declared enum order. An index out of range is UNAVAILABLE. */
export const MARKETPLACE_STATUSES = Object.freeze({
  FixedPriceListing: Object.freeze(['Active', 'Sold', 'Cancelled', 'Expired']),
  ItemOffer: Object.freeze(['Active', 'Accepted', 'Cancelled', 'Expired']),
  CollectionBid: Object.freeze(['Active', 'PartiallyFilled', 'Filled', 'Cancelled', 'Expired']),
});

/** Canonical native TARI. `validate_quote_resource` accepts exactly this plus public fungibles. */
export const CANONICAL_TARI_RESOURCE =
  'resource_0101010101010101010101010101010101010101010101010101010101010101';

/**
 * The two wallet accounts this tool is allowed to act as.
 *
 * `accounts.set_default` is the daemon's official account-selection mechanism, and it
 * is the ONLY thing that makes the daemon sign as that account. The marketplace
 * templates bind `cancel` to `CallerContext::transaction_signer_public_key()`, so the
 * acting account is a security-relevant fact, not a convenience: the binding is
 * re-verified immediately before every submission and refused on mismatch.
 *
 * `ownerPublicKey` is recorded here so a receipt can be attributed to an account
 * WITHOUT any private material.
 */
export const MARKETPLACE_ACCOUNTS = Object.freeze({
  A: Object.freeze({
    label: 'A',
    name: 'Purrivacy Swap',
    component: 'component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b',
    ownerPublicKey: '74654347e7e08d8c2116ee3e43c7f98bda0d619e1a0cc94faacb55ff36d57341',
  }),
  B: Object.freeze({
    label: 'B',
    name: 'V042_ATOMICSWAP_TEST_COUNTERPARTY',
    component: 'component_b510055406cbe43325aa7790a38f980eb03d354f525b0acc7c59461b07dde77d',
    ownerPublicKey: 'fe414098593ef5272c6eca981309aebd36481ec293cfe9e73daae04d8802d824',
  }),
});

export function assertKnownAccount(label) {
  const key = String(label ?? '').trim().toUpperCase();
  const acct = MARKETPLACE_ACCOUNTS[key];
  if (!acct) {
    throw new ExecutorError(
      `REFUSED: unknown account label "${label}". This tool may only act as ` +
        `${Object.keys(MARKETPLACE_ACCOUNTS).join(' or ')}; it will not resolve an arbitrary account address.`,
    );
  }
  return acct;
}

export function assertKnownTemplate(templateName) {
  const expected = MARKETPLACE_TEMPLATES[templateName];
  if (!expected) throw new ExecutorError(`REFUSED: unknown marketplace template name "${templateName}".`);
  return expected;
}

/** Refuse an on-chain template address that is not the published one we audited. */
export function assertPublishedTemplateAddress(templateName, address) {
  const expected = assertKnownTemplate(templateName);
  const bare = String(address ?? '').replace(/^template_/, '');
  if (bare !== expected) {
    throw new ExecutorError(
      `REFUSED: component claims template ${address}, but the published ${templateName} on Esmeralda is template_${expected}.`,
    );
  }
  return expected;
}

/** An NFT identity is the exact `(resource, token id)` pair. Never a name or a symbol. */
export function assertNftIdentity(nftResource, nftId) {
  if (!/^resource_[0-9a-f]{64}$/.test(String(nftResource ?? ''))) {
    throw new ExecutorError(`nft resource "${nftResource}" is not a resource address`);
  }
  if (typeof nftId !== 'string' || nftId.length === 0 || nftId.length > 256) {
    throw new ExecutorError(`nft id must be a non-empty string, got ${JSON.stringify(nftId)}`);
  }
  // The manifest embeds the id in `non_fungible_id!("...")`; a quote would break out of it.
  if (/["\\]/.test(nftId)) {
    throw new ExecutorError(`nft id "${nftId}" contains a character the manifest dialect cannot encode`);
  }
  return { nftResource, nftId };
}

function assertPositiveAmountMicro(value, field) {
  if (!/^[1-9]\d{0,19}$/.test(String(value))) {
    throw new ExecutorError(
      `${field} must be a positive integer string of micro-units, got ${JSON.stringify(value)}`,
    );
  }
  return String(value);
}

function assertExpiry(expiryEpoch) {
  const n = Number(expiryEpoch);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ExecutorError(`expiry epoch must be a non-negative integer, got ${JSON.stringify(expiryEpoch)}`);
  }
  return n;
}

function assertComponent(address) {
  if (!/^component_[0-9a-f]{64}$/.test(String(address ?? ''))) {
    throw new ExecutorError(`component "${address}" is not a component address`);
  }
  return address;
}

export class NftMarketExecutor {
  /**
   * @param {object} opts
   * @param {string} [opts.url] loopback walletd base URL
   * @param {number} [opts.maxFeePerTxMicro] per-tx ceiling (<= the run's 2 tTARI limit)
   * @param {string} [opts.ledgerPath] durable ledger path
   */
  constructor(opts = {}) {
    this.inner = new WalletdExecutor({
      ...opts,
      maxFeePerTxMicro: Math.min(
        opts.maxFeePerTxMicro ?? MAX_FEE_PER_MARKETPLACE_TX_MICRO,
        MAX_FEE_PER_MARKETPLACE_TX_MICRO,
      ),
    });
    this.url = this.inner.url;
    this.ledgerPath = this.inner.ledgerPath;
    /** cumulative micro-tTARI actually observed as PAID by committed transactions */
    this.feesPaidMicro = 0;
    this.epoch = null;
  }

  rpc(method, params = {}, opts = {}) {
    return this.inner.rpc(method, params, opts);
  }

  async authenticate() {
    return this.inner.authenticate();
  }

  /** Fail-closed network preflight. Never inferred. */
  async verifyNetwork() {
    const identity = await this.inner.verifyNetwork();
    this.epoch = identity.epoch;
    return identity;
  }

  async walletVersion() {
    const r = await this.rpc('wallet.get_info', {});
    return String(r?.version ?? 'unknown');
  }

  /** The daemon's official account-selection mechanism. */
  async setDefaultAccount(label) {
    const acct = assertKnownAccount(label);
    await this.rpc('accounts.set_default', { account: acct.component });
    const now = await this.inner.defaultAccount();
    if (now.component !== acct.component) {
      throw new ExecutorError(
        `REFUSED: account selection did not take effect. Asked for ${acct.label} (${acct.component}) ` +
          `but the daemon default is ${now.component}.`,
      );
    }
    return { ...acct, daemonDefault: now.component, daemonDefaultName: now.name };
  }

  /** Refuse to sign as anyone other than the account the caller named. */
  async assertSigner(label) {
    const acct = assertKnownAccount(label);
    const now = await this.inner.defaultAccount();
    if (now.component !== acct.component) {
      throw new ExecutorError(
        `REFUSED: signer binding mismatch. Operation requires account ${acct.label} (${acct.component}) to sign, ` +
          `but the daemon default account is ${now.component}. Refusing to submit.`,
      );
    }
    return acct;
  }

  /**
   * Authoritative inventory of every non-fungible item held by an account.
   *
   * The resource address and the token id are read from the VAULT substate, not from
   * the resource symbol: `V042R` is a ticker shared by four different resources, and
   * the symbol is NOT authoritative. Mutable NFT data is deliberately not consulted.
   */
  async nftInventory(label) {
    const acct = assertKnownAccount(label);
    const balances = await this.rpc('accounts.get_balances', { account: acct.component });
    const rows = [];
    for (const b of balances?.balances ?? []) {
      if (b.resource_type !== 'NonFungible') continue;
      const vault = await this.rpc('substates.get', { substate_id: b.vault_address }).catch(() => null);
      const container = vault?.substate_from_remote?.substate?.Vault?.resource_container?.NonFungible;
      const tokenIds = Array.isArray(container?.token_ids) ? container.token_ids.map(unpackTokenId) : [];
      const locked = Array.isArray(container?.locked_token_ids) ? container.locked_token_ids.map(unpackTokenId) : [];
      rows.push({
        nftResource: b.resource_address,
        symbol: b.token_symbol,
        vaultAddress: b.vault_address,
        tokenIds,
        lockedTokenIds: locked,
        reportedBalance: b.balance,
        // Disagreement between the wallet's own count and the vault contents is surfaced,
        // never averaged over.
        consistent: Number(b.balance) === tokenIds.length,
      });
    }
    rows.sort((x, y) => (x.nftResource < y.nftResource ? -1 : x.nftResource > y.nftResource ? 1 : 0));
    return {
      account: acct,
      resources: rows,
      items: rows.flatMap((r) => r.tokenIds.map((id) => ({ nftResource: r.nftResource, nftId: id, vaultAddress: r.vaultAddress }))),
    };
  }

  /** Locate exactly one NFT identity in an account's authoritative inventory. */
  async findNft(label, nftResource, nftId) {
    const inv = await this.nftInventory(label);
    const hit = inv.items.find((i) => i.nftResource === nftResource && i.nftId === nftId);
    return { inventory: inv, held: Boolean(hit), item: hit ?? null };
  }

  /** Fungible (public, non-confidential) balance of an account for a resource. */
  async publicBalance(label, resourceAddress) {
    const acct = assertKnownAccount(label);
    const balances = await this.rpc('accounts.get_balances', { account: acct.component });
    const row = (balances?.balances ?? []).find((b) => b.resource_address === resourceAddress);
    if (!row) return { resource: resourceAddress, balance: '0', present: false, resourceType: undefined };
    return {
      resource: resourceAddress,
      balance: String(row.balance),
      confidential: String(row.confidential_balance),
      present: true,
      resourceType: row.resource_type,
      symbol: row.token_symbol,
      divisibility: row.divisibility,
      vaultAddress: row.vault_address,
    };
  }

  /**
   * The security posture of a marketplace component, read from the component's OWN
   * substate header (never from the transaction that created it).
   */
  async componentSecurity(componentAddress) {
    assertComponent(componentAddress);
    const s = await this.rpc('substates.get', { substate_id: componentAddress });
    const c = s?.substate_from_remote?.substate?.Component;
    if (!c) throw new ExecutorError(`substate ${componentAddress} is not a Component`);
    const header = c.header ?? {};
    const rules = header.access_rules ?? {};
    const templateAddress = hexOf(header.template_address);
    const templateName =
      Object.entries(MARKETPLACE_TEMPLATES).find(([, addr]) => addr === templateAddress)?.[0] ?? 'UNKNOWN_TEMPLATE';
    const methodAccess = rules.method_access ?? {};
    return {
      componentAddress,
      templateAddress,
      templateName,
      /** false means this component is NOT the audited published template. */
      templateMatchesAudit: templateName !== 'UNKNOWN_TEMPLATE',
      ownerRule: header.owner_rule ?? null,
      /** `None` is the requirement: an ownerless component cannot be administratively drained. */
      ownerRuleIsNone: (header.owner_rule ?? null) === 'None',
      defaultRule: rules.default ?? null,
      methodAccess,
      /** `buy`/`accept`/`fill` MUST be permissionless; `cancel` MUST be signer-bound. */
      fillIsPermissionless: isPermissionless(methodAccess),
      cancelIsSignerBound: isSignerBound(methodAccess.cancel),
    };
  }

  /**
   * A marketplace component's authoritative settlement facts.
   *
   * v0.46.0 (upstream #2859) stopped recording template return values in the transaction
   * result — `FinalizeResult.execution_results` is retired — so a `listing()`/`offer()`/`bid()`
   * dry run no longer yields anything to read. Upstream's own instruction for that change is
   * "read component state or events instead", which is what this does: the component's own
   * substate, plus the escrow vault it actually holds.
   *
   * This is strictly stronger than the retired path was. The getter returned only what the
   * component CLAIMED; the substate read is additionally pinned to the published template
   * address and cross-checks the escrow vault's resource against the declared one, so a
   * component that merely looks like a listing cannot be accepted.
   *
   * An undecodable readback is UNAVAILABLE, never guessed.
   */
  async readMarketplace(kind, componentAddress) {
    assertKnownTemplate(kind);
    assertComponent(componentAddress);
    const templateAddress = MARKETPLACE_TEMPLATES[kind];
    const facts = await decodeMarketplaceFacts(kind, this.rawSubstateReader(), componentAddress, templateAddress);
    return {
      kind,
      getter: MARKETPLACE_GETTERS[kind],
      componentAddress,
      templateAddress,
      escrow: facts.escrow,
      decoded: facts.listing ?? facts.itemOffer ?? facts.collectionBid ?? null,
    };
  }

  /**
   * walletd `substates.get` as the raw substate-value reader the protocol-client decoders want.
   *
   * The decoders are fail-closed by construction: a component with no template address, a
   * vault with no resource container, or a state tuple of the wrong arity throws, and the
   * caller must treat that as UNAVAILABLE.
   */
  rawSubstateReader() {
    return {
      read: async (address) => {
        const r = await this.rpc('substates.get', { substate_id: address });
        return r?.substate_from_remote?.substate;
      },
    };
  }

  /**
   * Submit a marketplace manifest. Dry-runs first, enforces BOTH the per-tx fee ceiling
   * and the cumulative run budget, re-verifies the signer binding, records identity to
   * the ledger, submits ONCE, reconciles, and attributes the paid fee.
   */
  async submit(spec) {
    const acct = await this.assertSigner(spec.asAccount);
    assertKnownTemplate(spec.templateName);
    const ceiling = Math.min(
      spec.maxFeeMicro ?? MAX_FEE_PER_MARKETPLACE_TX_MICRO,
      MAX_FEE_PER_MARKETPLACE_TX_MICRO,
      this.inner.maxFeePerTxMicro,
    );
    if (this.feesPaidMicro + ceiling > FEE_BUDGET_TOTAL_MICRO) {
      throw new ExecutorError(
        `REFUSED: this submission's ceiling (${ceiling}) would take the run's total fees past the ` +
          `${FEE_BUDGET_TOTAL_MICRO} micro-tTARI budget (${this.feesPaidMicro} already paid).`,
      );
    }
    const result = await this.inner.submitManifest({
      opId: spec.opId,
      intent: spec.intent,
      manifest: spec.manifest,
      variables: spec.variables,
      maxFeeMicro: ceiling,
      dryRunOnly: spec.dryRun === true,
      meta: {
        ...(spec.meta ?? {}),
        signerAccount: acct.label,
        signerComponent: acct.component,
        signerPublicKey: acct.ownerPublicKey,
      },
    });
    if (!result.dryRun && typeof result.outcome?.actualFee === 'number') {
      this.feesPaidMicro += result.outcome.actualFee;
    }
    return { ...result, signer: acct, feesPaidMicroTotal: this.feesPaidMicro };
  }
}

/** `AccessRule::AllowAll` appears as the bare string in a decoded component header. */
function isPermissionless(methodAccess) {
  const entry = Object.entries(methodAccess).find(([m]) => m === 'buy' || m === 'accept' || m === 'fill');
  return entry !== undefined && entry[1] === 'AllowAll';
}

/** `rule!(public_key(signer))` appears as a nested Restricted/Require shape. */
function isSignerBound(rule) {
  if (rule === undefined || rule === null) return false;
  const serialised = JSON.stringify(rule);
  return /Require/.test(serialised) && /NonFungibleAddress/.test(serialised);
}

// ---------------------------------------------------------------------------
// Manifest builders. Each returns the manifest TEXT; the instruction sequence is the
// same one the wallet-adapter intents describe, in the daemon's dialect.
// ---------------------------------------------------------------------------

export function createListingManifest({ sellerAccount, nftResource, nftId, quoteResource, priceMicro, expiryEpoch }) {
  assertNftIdentity(nftResource, nftId);
  assertPositiveAmountMicro(priceMicro, 'price');
  const tpl = assertKnownTemplate('FixedPriceListing');
  return {
    templateName: 'FixedPriceListing',
    templateAddress: tpl,
    manifest: `use template_${tpl} as FixedPriceListing;
fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("${nftId}"));
  FixedPriceListing::create(account, nft, arg!["quote_resource"], amount!(${priceMicro}), ${assertExpiry(expiryEpoch)}u64);
}`,
    variables: { account: sellerAccount, nft_resource: nftResource, quote_resource: quoteResource },
  };
}

export function buyListingManifest({ buyerAccount, listing, quoteResource, priceMicro }) {
  assertComponent(listing);
  assertPositiveAmountMicro(priceMicro, 'price');
  return {
    templateName: 'FixedPriceListing',
    manifest: `fn main() {
  let account = arg!["account"];
  let listing = arg!["listing"];
  let payment = account.withdraw(arg!["quote_resource"], amount!(${priceMicro}));
  listing.buy(payment, account);
}`,
    variables: { account: buyerAccount, listing, quote_resource: quoteResource },
  };
}

export function cancelListingManifest({ listing }) {
  assertComponent(listing);
  return {
    templateName: 'FixedPriceListing',
    manifest: `fn main() {
  let listing = arg!["listing"];
  listing.cancel();
}`,
    variables: { listing },
  };
}

export function createItemOfferManifest({ buyerAccount, quoteResource, offerMicro, nftResource, nftId, expiryEpoch }) {
  assertNftIdentity(nftResource, nftId);
  assertPositiveAmountMicro(offerMicro, 'offer amount');
  const tpl = assertKnownTemplate('ItemOffer');
  return {
    templateName: 'ItemOffer',
    templateAddress: tpl,
    manifest: `use template_${tpl} as ItemOffer;
fn main() {
  let account = arg!["account"];
  let quote = account.withdraw(arg!["quote_resource"], amount!(${offerMicro}));
  ItemOffer::create(account, quote, arg!["nft_resource"], non_fungible_id!("${nftId}"), ${assertExpiry(expiryEpoch)}u64);
}`,
    variables: { account: buyerAccount, quote_resource: quoteResource, nft_resource: nftResource },
  };
}

export function acceptItemOfferManifest({ sellerAccount, offer, nftResource, nftId }) {
  assertComponent(offer);
  assertNftIdentity(nftResource, nftId);
  return {
    templateName: 'ItemOffer',
    manifest: `fn main() {
  let account = arg!["account"];
  let offer = arg!["offer"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("${nftId}"));
  offer.accept(nft, account);
}`,
    variables: { account: sellerAccount, offer, nft_resource: nftResource },
  };
}

export function cancelItemOfferManifest({ offer }) {
  assertComponent(offer);
  return {
    templateName: 'ItemOffer',
    manifest: `fn main() {
  let offer = arg!["offer"];
  offer.cancel();
}`,
    variables: { offer },
  };
}

export function refundExpiredItemOfferManifest({ offer }) {
  assertComponent(offer);
  return {
    templateName: 'ItemOffer',
    manifest: `fn main() {
  let offer = arg!["offer"];
  offer.refund_expired();
}`,
    variables: { offer },
  };
}

export function createCollectionBidManifest({
  buyerAccount,
  quoteResource,
  pricePerNftMicro,
  quantity,
  collectionResource,
  expiryEpoch,
}) {
  assertPositiveAmountMicro(pricePerNftMicro, 'price per nft');
  const q = String(quantity);
  if (!/^[1-9]\d{0,9}$/.test(q)) throw new ExecutorError(`quantity must be a positive integer string, got ${q}`);
  if (!/^resource_[0-9a-f]{64}$/.test(String(collectionResource ?? ''))) {
    throw new ExecutorError(`collection "${collectionResource}" is not a resource address`);
  }
  const escrow = (BigInt(pricePerNftMicro) * BigInt(q)).toString();
  const tpl = assertKnownTemplate('CollectionBid');
  return {
    templateName: 'CollectionBid',
    templateAddress: tpl,
    manifest: `use template_${tpl} as CollectionBid;
fn main() {
  let account = arg!["account"];
  let quote = account.withdraw(arg!["quote_resource"], amount!(${escrow}));
  CollectionBid::create(account, quote, arg!["collection"], amount!(${pricePerNftMicro}), ${q}u64, ${assertExpiry(expiryEpoch)}u64);
}`,
    variables: { account: buyerAccount, quote_resource: quoteResource, collection: collectionResource },
  };
}

export function fillCollectionBidManifest({ sellerAccount, bid, nftResource, nftId }) {
  assertComponent(bid);
  assertNftIdentity(nftResource, nftId);
  return {
    templateName: 'CollectionBid',
    manifest: `fn main() {
  let account = arg!["account"];
  let bid = arg!["bid"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("${nftId}"));
  bid.fill(nft, account);
}`,
    variables: { account: sellerAccount, bid, nft_resource: nftResource },
  };
}

export function cancelCollectionBidManifest({ bid }) {
  assertComponent(bid);
  return {
    templateName: 'CollectionBid',
    manifest: `fn main() {
  let bid = arg!["bid"];
  bid.cancel();
}`,
    variables: { bid },
  };
}

export function refundExpiredCollectionBidManifest({ bid }) {
  assertComponent(bid);
  return {
    templateName: 'CollectionBid',
    manifest: `fn main() {
  let bid = arg!["bid"];
  bid.refund_expired();
}`,
    variables: { bid },
  };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const CBOR_TAGS = { ComponentAddress: 128, ResourceAddress: 131, Vault: 132, Amount: 133 };

export function hexOf(tagged) {
  if (typeof tagged === 'string') return tagged;
  if (tagged && typeof tagged === 'object' && tagged['@cbor'] === 'tag') return tagged.value?.hex;
  return undefined;
}

/**
 * Decode a getter return value into plain settlement facts.
 *
 * A getter returning a struct arrives as a positional array in the template's declared
 * field order. Anything we cannot decode fails CLOSED: the caller gets `null` and must
 * treat the readback as unavailable rather than inferring a status.
 */
export function decodeMarketplaceValue(templateName, value) {
  try {
    const arr = toPlainArray(value);
    if (!Array.isArray(arr)) return null;
    if (templateName === 'FixedPriceListing') {
      return {
        nftResource: asResource(arr[0]),
        nftId: asNftId(arr[1]),
        quoteResource: asResource(arr[2]),
        price: asAmount(arr[3]),
        sellerAccount: asComponent(arr[4]),
        expiresAtEpoch: asNumber(arr[5]),
        status: asVariant(arr[6], MARKETPLACE_STATUSES.FixedPriceListing),
      };
    }
    if (templateName === 'ItemOffer') {
      return {
        nftResource: asResource(arr[0]),
        nftId: asNftId(arr[1]),
        quoteResource: asResource(arr[2]),
        offerAmount: asAmount(arr[3]),
        buyerAccount: asComponent(arr[4]),
        createdAtEpoch: asNumber(arr[5]),
        expiresAtEpoch: asNumber(arr[6]),
        status: asVariant(arr[7], MARKETPLACE_STATUSES.ItemOffer),
      };
    }
    if (templateName === 'CollectionBid') {
      return {
        collection: asResource(arr[0]),
        quoteResource: asResource(arr[1]),
        pricePerNft: asAmount(arr[2]),
        originalQuantity: asNumber(arr[3]),
        remainingQuantity: asNumber(arr[4]),
        originalEscrow: asAmount(arr[5]),
        remainingEscrow: asAmount(arr[6]),
        buyerAccount: asComponent(arr[7]),
        createdAtEpoch: asNumber(arr[8]),
        expiresAtEpoch: asNumber(arr[9]),
        status: asVariant(arr[10], MARKETPLACE_STATUSES.CollectionBid),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function toPlainArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && value['@cbor'] === 'array') return value.entries ?? [];
  return null;
}

function asResource(v) {
  if (v && typeof v === 'object' && v['@cbor'] === 'tag' && v.tag === CBOR_TAGS.ResourceAddress) {
    return `resource_${v.value?.hex}`;
  }
  return undefined;
}

function asComponent(v) {
  if (v && typeof v === 'object' && v['@cbor'] === 'tag' && v.tag === CBOR_TAGS.ComponentAddress) {
    return `component_${v.value?.hex}`;
  }
  return undefined;
}

function asAmount(v) {
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  if (v && typeof v === 'object' && v['@cbor'] === 'tag' && v.tag === CBOR_TAGS.Amount) return String(v.value);
  if (v && typeof v === 'object' && v['@cbor'] === 'uint') return String(v.value);
  return undefined;
}

function asNumber(v) {
  if (typeof v === 'number' || typeof v === 'string') return Number(v);
  if (v && typeof v === 'object' && v['@cbor'] === 'uint') return Number(v.value);
  return undefined;
}

function asNftId(v) {
  // NonFungibleId is CBOR `[variantIndex, [payload]]`; variant 1 is `String`.
  const arr = toPlainArray(v);
  if (!Array.isArray(arr) || arr.length !== 2) return undefined;
  const variant = Number(arr[0]);
  const payload = toPlainArray(arr[1]);
  if (variant === 1 && Array.isArray(payload) && typeof payload[0] === 'string') return payload[0];
  if (variant === 0 && Array.isArray(payload)) return `u64:${payload[0]}`;
  return undefined;
}

function asVariant(v, names) {
  const arr = toPlainArray(v);
  if (!Array.isArray(arr) || arr.length !== 2) return undefined;
  return names[Number(arr[0])] ?? undefined;
}

export function unpackTokenId(t) {
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object' && typeof t.String === 'string') return t.String;
  if (t && typeof t === 'object' && t.U64 !== undefined) return `u64:${t.U64}`;
  return undefined;
}