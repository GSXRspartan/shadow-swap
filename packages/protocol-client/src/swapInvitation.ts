/**
 * Shareable SwapOffer invitations: a versioned, copy-pasteable pointer to an on-chain offer.
 *
 *   shadowswap-offer:v1:<base64url(canonical JSON)>
 *
 * An invitation is a CLAIM, not a fact. It is exchanged peer to peer (chat, email, QR); no
 * server matches orders and no server sees it. Importing one never trusts it:
 * `verifyInvitation` compares every term against the offer decoded from chain state
 * (`decodeSwapOffer`) and the UI shows the CHAIN terms. Any disagreement -- a forged amount, a
 * swapped resource, a dropped designated taker, a different hash lock or expiry, another
 * network -- makes the offer unfillable from that invitation, with the difference stated.
 *
 * Invitations never carry secrets: no keys, seeds or view keys, and NOT the hash-lock
 * preimage (anyone holding the invitation could otherwise satisfy the lock). Unknown fields
 * are refused rather than ignored, so a payload cannot smuggle anything a later version might
 * act on.
 */

import type { SwapOfferState } from './swapOfferSubstate.js';
import { swapOfferExpired } from './swapOfferSubstate.js';

export const INVITATION_PREFIX = 'shadowswap-offer:v1:';
export const INVITATION_MAX_CHARS = 4096;
const MEMO_MAX = 140;

export type InvitationAsset = { kind: 'fungible'; resource: string; amount: string } | { kind: 'nft'; resource: string; nftId: string };

export interface SwapOfferInvitation {
  readonly v: 1;
  /** Network name as the wallet reports it (e.g. `esmeralda`). */
  readonly network: string;
  /** Protocol deployment generation (e.g. `v048`), so a reset network's invitations fail closed. */
  readonly generation: string;
  /** SwapOffer template, 64 hex. */
  readonly template: string;
  readonly component: string;
  readonly offered: InvitationAsset;
  readonly requested: InvitationAsset;
  /** Maker public key (64 hex). */
  readonly maker: string;
  readonly designatedTaker: string | null;
  readonly hashLock: string | null;
  readonly expiresAtEpoch: string;
  /** Free text, display only, never interpreted. */
  readonly memo?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const RAW = /^(?:0|[1-9]\d*)$/;
const NFT_ID = /^(?:uuid_[0-9a-f]{64}|str_.{1,64}|u32_(?:0|[1-9]\d*)|u64_(?:0|[1-9]\d*))$/su;
const KEYS = ['component', 'designatedTaker', 'expiresAtEpoch', 'generation', 'hashLock', 'maker', 'memo', 'network', 'offered', 'requested', 'template', 'v'];
const SECRET_LIKE = /^(?:preimage|secret|seed|mnemonic|private.?key|view.?key|spend.?key|password|mask)$/i;

export class InvitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvitationError';
  }
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new InvitationError('the invitation body is not base64url');
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function asset(value: unknown, field: string): InvitationAsset {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvitationError(`${field} is not an object`);
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (typeof v.resource !== 'string' || !/^resource_[0-9a-f]{64}$/.test(v.resource)) throw new InvitationError(`${field}.resource is not a resource address`);
  if (v.kind === 'fungible') {
    if (keys !== 'amount,kind,resource') throw new InvitationError(`${field} has unexpected fields`);
    if (typeof v.amount !== 'string' || !RAW.test(v.amount) || v.amount === '0') throw new InvitationError(`${field}.amount is not a positive raw integer`);
    return { kind: 'fungible', resource: v.resource, amount: v.amount };
  }
  if (v.kind === 'nft') {
    if (keys !== 'kind,nftId,resource') throw new InvitationError(`${field} has unexpected fields`);
    if (typeof v.nftId !== 'string' || !NFT_ID.test(v.nftId)) throw new InvitationError(`${field}.nftId is not a canonical NonFungibleId`);
    return { kind: 'nft', resource: v.resource, nftId: v.nftId };
  }
  throw new InvitationError(`${field}.kind must be "fungible" or "nft"`);
}

function hexOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !HEX64.test(value)) throw new InvitationError(`${field} must be 64 lowercase hex or null`);
  return value;
}

/** Validate an already-parsed payload. */
export function validateInvitation(value: unknown): SwapOfferInvitation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvitationError('the invitation is not an object');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (SECRET_LIKE.test(key)) throw new InvitationError(`the invitation carries "${key}": invitations never carry secrets, and this one is refused`);
    if (!KEYS.includes(key)) throw new InvitationError(`unknown field "${key}"`);
  }
  if (v.v !== 1) throw new InvitationError(`unsupported invitation version ${JSON.stringify(v.v)}`);
  if (typeof v.network !== 'string' || !/^[a-z0-9-]{1,32}$/.test(v.network)) throw new InvitationError('network is missing or malformed');
  if (typeof v.generation !== 'string' || !/^[a-z0-9.-]{1,16}$/.test(v.generation)) throw new InvitationError('generation is missing or malformed');
  if (typeof v.template !== 'string' || !HEX64.test(v.template)) throw new InvitationError('template must be 64 lowercase hex');
  if (typeof v.component !== 'string' || !/^component_[0-9a-f]{64}$/.test(v.component)) throw new InvitationError('component is not a component address');
  const offered = asset(v.offered, 'offered');
  const requested = asset(v.requested, 'requested');
  if (offered.resource === requested.resource) throw new InvitationError('offered and requested resources are the same');
  const maker = hexOrNull(v.maker, 'maker');
  if (maker === null) throw new InvitationError('maker is required');
  if (typeof v.expiresAtEpoch !== 'string' || !RAW.test(v.expiresAtEpoch)) throw new InvitationError('expiresAtEpoch must be a raw integer string');
  let memo: string | undefined;
  if (v.memo !== undefined) {
    if (typeof v.memo !== 'string' || v.memo.length > MEMO_MAX || /[\u0000-\u001f\u007f]/.test(v.memo)) throw new InvitationError(`memo must be plain text of at most ${MEMO_MAX} characters`);
    memo = v.memo;
  }
  return {
    v: 1,
    network: v.network,
    generation: v.generation,
    template: v.template,
    component: v.component,
    offered,
    requested,
    maker,
    designatedTaker: hexOrNull(v.designatedTaker, 'designatedTaker'),
    hashLock: hexOrNull(v.hashLock, 'hashLock'),
    expiresAtEpoch: v.expiresAtEpoch,
    ...(memo !== undefined ? { memo } : {}),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function encodeInvitation(invitation: SwapOfferInvitation): string {
  const valid = validateInvitation(invitation);
  return INVITATION_PREFIX + b64urlEncode(canonical(valid));
}

/** Parse pasted text. Whitespace around the code is tolerated; anything else is refused. */
export function parseInvitation(text: string): SwapOfferInvitation {
  const trimmed = text.trim();
  if (trimmed.length > INVITATION_MAX_CHARS) throw new InvitationError('the invitation is too long');
  if (!trimmed.startsWith(INVITATION_PREFIX)) {
    if (trimmed.startsWith('shadowswap-offer:')) throw new InvitationError('this invitation was made by an unsupported version');
    throw new InvitationError('this is not a Shadow Swap offer invitation');
  }
  let json: unknown;
  try {
    json = JSON.parse(b64urlDecode(trimmed.slice(INVITATION_PREFIX.length)));
  } catch (error) {
    if (error instanceof InvitationError) throw error;
    throw new InvitationError('the invitation body is not valid JSON');
  }
  return validateInvitation(json);
}

/** Builds the invitation for an offer FROM its decoded chain state (never from form input). */
export function invitationFromChain(state: SwapOfferState, ctx: { network: string; generation: string; memo?: string }): SwapOfferInvitation {
  const offered: InvitationAsset =
    state.offered.containerKind === 'NonFungible'
      ? (() => {
          if (state.offered.tokenIds.length !== 1) throw new InvitationError('an invitation describes exactly one escrowed NFT');
          return { kind: 'nft', resource: state.offered.resourceAddress, nftId: state.offered.tokenIds[0]! } as const;
        })()
      : { kind: 'fungible', resource: state.offered.resourceAddress, amount: state.offered.amount };
  const requested: InvitationAsset =
    state.requested.nftId !== null ? { kind: 'nft', resource: state.requested.resource, nftId: state.requested.nftId } : { kind: 'fungible', resource: state.requested.resource, amount: state.requested.amount };
  return validateInvitation({
    v: 1,
    network: ctx.network,
    generation: ctx.generation,
    template: state.templateAddress,
    component: state.component,
    offered,
    requested,
    maker: state.maker,
    designatedTaker: state.designatedTaker,
    hashLock: state.hashLock,
    expiresAtEpoch: state.expiresAtEpoch,
    ...(ctx.memo !== undefined && ctx.memo !== '' ? { memo: ctx.memo } : {}),
  });
}

export interface InvitationVerdict {
  /** True only when the chain offer is open, unexpired, fillable by this taker and EVERY term agrees. */
  readonly fillable: boolean;
  /** Terms where the invitation disagrees with chain state. Non-empty = forged or stale. */
  readonly mismatches: readonly string[];
  /** Other reasons the offer cannot be filled now. */
  readonly blockers: readonly string[];
  /** True facts the taker must know but that do not block (the network still enforces them). */
  readonly warnings: readonly string[];
  readonly requiresPreimage: boolean;
  /** The terms to show and to sign: ALWAYS the chain's. */
  readonly chain: SwapOfferState;
}

function describe(a: InvitationAsset): string {
  return a.kind === 'fungible' ? `${a.amount} of ${a.resource}` : `NFT ${a.nftId} of ${a.resource}`;
}

export function verifyInvitation(invitation: SwapOfferInvitation, chain: SwapOfferState, ctx: { network: string; generation: string; currentEpoch?: string; takerPublicKey?: string }): InvitationVerdict {
  const mismatches: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (invitation.network !== ctx.network) mismatches.push(`the invitation is for network ${invitation.network}, your wallet is on ${ctx.network}`);
  if (invitation.generation !== ctx.generation) mismatches.push(`the invitation is for deployment ${invitation.generation}, this network is ${ctx.generation}`);
  if (invitation.component !== chain.component) mismatches.push('the invitation names a different offer component');
  if (invitation.template !== chain.templateAddress) mismatches.push(`the invitation names template ${invitation.template}, the offer is ${chain.templateAddress}`);
  const offered = invitation.offered;
  if (offered.resource !== chain.offered.resourceAddress) mismatches.push(`offered: invitation says ${describe(offered)}, chain escrow holds ${chain.offered.resourceAddress}`);
  else if (offered.kind === 'fungible') {
    if (chain.offered.containerKind === 'NonFungible') mismatches.push('offered: invitation says a fungible amount, chain escrow holds NFTs');
    else if (offered.amount !== chain.offered.amount) mismatches.push(`offered: invitation says ${offered.amount}, chain escrow holds ${chain.offered.amount}`);
  } else if (chain.offered.containerKind !== 'NonFungible' || chain.offered.tokenIds.length !== 1 || chain.offered.tokenIds[0] !== offered.nftId) {
    mismatches.push(`offered: invitation says NFT ${offered.nftId}, chain escrow holds ${chain.offered.tokenIds.join(', ') || 'no NFT'}`);
  }
  const requested = invitation.requested;
  if (requested.resource !== chain.requested.resource) mismatches.push(`requested: invitation says ${requested.resource}, the offer wants ${chain.requested.resource}`);
  else if (requested.kind === 'fungible') {
    if (chain.requested.nftId !== null || requested.amount !== chain.requested.amount) mismatches.push(`requested: invitation says ${requested.amount}, the offer wants ${chain.requested.nftId ?? chain.requested.amount}`);
  } else if (chain.requested.nftId !== requested.nftId) mismatches.push(`requested: invitation says NFT ${requested.nftId}, the offer wants ${chain.requested.nftId ?? `${chain.requested.amount} units`}`);
  if (invitation.maker !== chain.maker) mismatches.push(`maker: invitation says ${invitation.maker}, the offer's maker key is ${chain.maker}`);
  if (invitation.designatedTaker !== chain.designatedTaker) mismatches.push(`designated taker: invitation says ${invitation.designatedTaker ?? 'anyone'}, chain says ${chain.designatedTaker ?? 'anyone'}`);
  if (invitation.hashLock !== chain.hashLock) mismatches.push(`hash lock: invitation says ${invitation.hashLock ?? 'none'}, chain says ${chain.hashLock ?? 'none'}`);
  if (invitation.expiresAtEpoch !== chain.expiresAtEpoch) mismatches.push(`expiry: invitation says ${invitation.expiresAtEpoch}, chain says ${chain.expiresAtEpoch}`);

  if (chain.status !== 'OPEN') blockers.push(`the offer is ${chain.status.toLowerCase()}`);
  if (ctx.currentEpoch !== undefined && swapOfferExpired(chain, ctx.currentEpoch)) blockers.push(`the offer expired at epoch ${chain.expiresAtEpoch}`);
  if (ctx.currentEpoch === undefined && chain.expiresAtEpoch !== '0') blockers.push('the current epoch is unknown, so expiry cannot be checked');
  if (chain.designatedTaker !== null) {
    if (ctx.takerPublicKey === undefined) {
      // No wallet API reports the account's signing key, so this cannot be checked in advance.
      // The engine enforces it (the `fill` access rule), so a fill from any other key fails
      // without moving funds.
      warnings.push(`only the key ${chain.designatedTaker} can fill this offer; a fill signed by any other key is refused by the network`);
    } else if (ctx.takerPublicKey !== chain.designatedTaker) blockers.push('this offer is reserved for a different key; the network will refuse your fill');
  }
  if (ctx.takerPublicKey !== undefined && ctx.takerPublicKey === chain.maker) blockers.push('this is your own offer');
  if (chain.hashLock !== null) warnings.push('this offer is hash-locked: filling it needs the preimage, which the maker shares separately and which becomes public once your fill is submitted');
  return { fillable: mismatches.length === 0 && blockers.length === 0, mismatches, blockers, warnings, requiresPreimage: chain.hashLock !== null, chain };
}
