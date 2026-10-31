/**
 * What an account ACTUALLY holds, read from its own vaults on chain.
 *
 * A wallet's balance list cannot answer "which NFT do I own?": Sapient's documented
 * `DappTokenBalance` carries amounts and metadata but no token ids (tari-wallet
 * `docs/integration/provider-api.md`), and a dApp must never ask a user to paste an internal
 * engine id to sell something they own. The ids are public on-chain data, so they are read
 * here from the account component's own vaults through the wallet's authoritative
 * `tari_getSubstate`.
 *
 * Reading chain state is also STRONGER than trusting the wallet's list: it reports the
 * container kind per resource (so a Confidential holding's blinded commitments are visible as
 * such), and it cannot report a holding the account does not have.
 *
 * Derivation: the account template stores `vaults: VaultMap` in its component state
 * (crates/template_builtin/templates/account/src/lib.rs at v0.48.0), so the vault ids are the
 * CBOR tag-132 nodes of that state — the same derivation upstream's own TS SDK uses
 * (`getVaultIdsForAccount`). Tested against engine-produced bytes in
 * `apps/web/test/account-inventory.test.cjs`.
 */

import { decodeVault, MarketplaceDecodeError, type MarketplaceEscrow, type MarketplaceRawSubstateReader } from './marketplaceSubstate.js';

/** CBOR tag for a `VaultId` object key. */
const TAG_VAULT = 132;
/** The account template's own cap on how many vaults an account may hold. */
const MAX_ACCOUNT_VAULTS = 256;

export interface AccountHolding extends MarketplaceEscrow {
  /**
   * True when this holding can be used by a mechanism that accounts in exact revealed
   * integers: a Fungible or Stealth container always can (a Stealth container has no
   * commitments at all), a Confidential one only while it carries none.
   */
  readonly revealedOnly: boolean;
}

export interface AccountInventory {
  readonly account: string;
  readonly holdings: readonly AccountHolding[];
  /**
   * Vaults that exist but could not be decoded, with the reason. Never silently dropped: a
   * holding we cannot read is reported so the UI can say so instead of implying the account
   * is empty.
   */
  readonly unreadable: readonly { readonly vaultAddress: string; readonly reason: string }[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Every CBOR tag-`tag` object key anywhere in a decoded substate value, in encounter order. */
export function collectObjectKeys(node: unknown, tag: number, into: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const entry of node) collectObjectKeys(entry, tag, into);
    return into;
  }
  const bag = record(node);
  if (bag === undefined) return into;
  if (bag['@cbor'] === 'tag') {
    if (bag.tag === tag) {
      const hex = record(bag.value)?.hex;
      if (typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex) && !into.includes(hex)) into.push(hex);
    }
    collectObjectKeys(bag.value, tag, into);
    return into;
  }
  if (bag['@cbor'] === 'map') {
    const entries = bag.entries;
    if (Array.isArray(entries)) {
      for (const pair of entries) {
        if (Array.isArray(pair) && pair.length === 2) {
          collectObjectKeys(pair[0], tag, into);
          collectObjectKeys(pair[1], tag, into);
        }
      }
    }
    return into;
  }
  for (const value of Object.values(bag)) collectObjectKeys(value, tag, into);
  return into;
}

/** The vault ids an account component's own state references. */
export function accountVaultIds(componentSubstate: unknown, account: string): string[] {
  const comp = record(record(componentSubstate)?.Component) ?? record(componentSubstate);
  const state = record(comp?.body)?.state;
  if (state === undefined) throw new MarketplaceDecodeError(`Account ${account} carries no component state`);
  const keys = collectObjectKeys(state, TAG_VAULT);
  if (keys.length > MAX_ACCOUNT_VAULTS) {
    throw new MarketplaceDecodeError(`Account ${account} references ${keys.length} vaults, beyond the account template's own limit of ${MAX_ACCOUNT_VAULTS}`);
  }
  return keys.map((hex) => `vault_${hex}`);
}

/**
 * Read everything `account` holds. One read for the component, then one per vault.
 *
 * Holdings are returned sorted by resource address, so the order is a function of chain state
 * and not of map iteration: a picker's list cannot reshuffle between reads.
 */
export async function readAccountInventory(reader: MarketplaceRawSubstateReader, account: string): Promise<AccountInventory> {
  if (!/^component_[0-9a-f]{64}$/.test(account)) throw new MarketplaceDecodeError(`${JSON.stringify(account)} is not an account component address`);
  const substate = await reader.read(account);
  if (substate === undefined || substate === null) throw new MarketplaceDecodeError(`Account ${account} does not exist or could not be read`);
  const holdings: AccountHolding[] = [];
  const unreadable: { vaultAddress: string; reason: string }[] = [];
  for (const vault of accountVaultIds(substate, account)) {
    try {
      const value = await reader.read(vault);
      if (value === undefined || value === null) {
        unreadable.push({ vaultAddress: vault, reason: 'the vault could not be read' });
        continue;
      }
      const decoded = decodeVault(value, vault);
      holdings.push({ ...decoded, revealedOnly: decoded.confidentialCommitments === 0 });
    } catch (error) {
      unreadable.push({ vaultAddress: vault, reason: (error as Error).message });
    }
  }
  holdings.sort((a, b) => (a.resourceAddress < b.resourceAddress ? -1 : a.resourceAddress > b.resourceAddress ? 1 : 0));
  return { account, holdings, unreadable };
}

/** The NFTs this account can offer: one entry per token id it actually holds. */
export function ownedNfts(inventory: AccountInventory): { resource: string; nftId: string }[] {
  return inventory.holdings
    .filter((h) => h.containerKind === 'NonFungible')
    .flatMap((h) => h.tokenIds.map((nftId) => ({ resource: h.resourceAddress, nftId })))
    .sort((a, b) => (a.resource === b.resource ? (a.nftId < b.nftId ? -1 : 1) : a.resource < b.resource ? -1 : 1));
}

/** The exact revealed amount of one resource, or '0'. Blinded commitments are never counted. */
export function revealedBalance(inventory: AccountInventory, resource: string): string {
  const holding = inventory.holdings.find((h) => h.resourceAddress === resource);
  return holding === undefined || holding.containerKind === 'NonFungible' ? '0' : holding.amount;
}

/** Whether this account holds exactly `nftId` of `resource` right now. */
export function ownsNft(inventory: AccountInventory, resource: string, nftId: string): boolean {
  return inventory.holdings.some((h) => h.resourceAddress === resource && h.containerKind === 'NonFungible' && h.tokenIds.includes(nftId));
}
