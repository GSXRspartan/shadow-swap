/**
 * ADDRESS DOMAINS.
 *
 * Tari has several kinds of address and they are NOT interchangeable. The
 * integration reference is blunt about it: "Wallet addresses are not component
 * addresses. Users hold `otl_esm_1…` (bech32m); instruction arguments need
 * `component_…`. Passing an `otl_…` where a `SubstateId` belongs fails deep in
 * deserialization as `data did not match any variant of untagged enum
 * TransactionInput`, naming neither the field nor the reason."
 *
 * The domains, as the published contract defines them:
 *
 *   ACCOUNT_COMPONENT  `component_…`   `tari_requestAccounts` / `tari_getAccounts`.
 *                                       Instruction arguments, SubstateIds, the
 *                                       account that settles a public AMM or NFT
 *                                       trade. NOT derivable from the wallet
 *                                       address by a client.
 *
 *   WALLET_ADDRESS     `otl_…`         `tari_getWalletAddress`, bech32m. What a
 *                                       private/stealth output is addressed TO.
 *                                       Never a SubstateId, never an instruction
 *                                       argument. Public keys only, so safe to
 *                                       hold and to show.
 *
 *   RESOURCE_ADDRESS   `otl_…` (other) The resource an amount is denominated in.
 *
 *   SUBSTATE_ADDRESS   `component_…`   An existing substate, read via
 *                                       `tari_getSubstate`.
 *
 * This module exists so a cross-domain substitution is a LOUD, early refusal
 * rather than a deep deserialization failure attributed to the user's wallet.
 *
 * The tests in this repository use obviously-synthetic placeholders that are
 * not real bech32 or real component addresses, so the classification here is
 * structural (domain-tagged wrappers and explicit guards) rather than purely
 * prefix-based. A prefix check is used only as a *refusal* signal for a value
 * that is confidently in another domain, never as an acceptance signal.
 */

export type AddressDomain =
  /** `component_…` account component, from the accounts methods. */
  | 'ACCOUNT_COMPONENT'
  /** Bech32m `otl_…` wallet address, from `tari_getWalletAddress`. */
  | 'WALLET_ADDRESS'
  /** A resource address. */
  | 'RESOURCE_ADDRESS'
  /** An existing substate address, read via `tari_getSubstate`. */
  | 'SUBSTATE_ADDRESS'
  /** Anything this module cannot classify. Callers must fail closed on it. */
  | 'OTHER';

/** A string tagged with the domain it is known to belong to. */
export interface Address<D extends AddressDomain = AddressDomain> {
  readonly value: string;
  readonly domain: D;
}

export class AddressDomainError extends Error {
  constructor(readonly expected: AddressDomain, readonly got: AddressDomain, readonly value: string, readonly field?: string) {
    super(
      `Refusing to use a ${got} address where a ${expected} address is required${field === undefined ? '' : ` (${field})`}: ${describe(value)}. The two address kinds are not interchangeable, and the chain would fail in deserialization rather than name the field.`,
    );
    this.name = 'AddressDomainError';
  }
}

function describe(value: string): string {
  if (value.length <= 24) return `"${value}"`;
  return `"${value.slice(0, 12)}…${value.slice(-6)}"`;
}

/**
 * Classify a bare string.
 *
 * This is a best-effort classification used for REFUSALS. A value that matches
 * no known shape is `OTHER`, and every caller below treats `OTHER` as a
 * failure at the point where a domain is required.
 */
export function classifyAddress(value: unknown): AddressDomain {
  if (typeof value !== 'string' || value === '') return 'OTHER';
  if (value.startsWith('component_')) return 'ACCOUNT_COMPONENT';
  // A bech32m Ootle address is `otl_1…` / `otl_esm_1…`. Resource addresses
  // share the `otl_` prefix, so a wallet address cannot be told apart from a
  // resource address by string alone — which is exactly why they are never
  // inferred from each other anywhere in this codebase.
  if (value.startsWith('otl_')) return 'WALLET_ADDRESS';
  return 'OTHER';
}

/** Tag a value the CALLER knows to be an account component address. */
export function accountComponent(value: string): Address<'ACCOUNT_COMPONENT'> {
  if (typeof value !== 'string' || value === '') throw new Error('An account component address must be a non-empty string.');
  return Object.freeze({ value, domain: 'ACCOUNT_COMPONENT' as const });
}

/** Tag a value the CALLER knows to be the connected account's wallet address. */
export function walletAddress(value: string): Address<'WALLET_ADDRESS'> {
  if (typeof value !== 'string' || value === '') throw new Error('A wallet address must be a non-empty string.');
  return Object.freeze({ value, domain: 'WALLET_ADDRESS' as const });
}

/**
 * Assert that a value is usable as an ACCOUNT COMPONENT address — the kind that
 * belongs in a `SubstateId` and in a public AMM / NFT instruction argument.
 *
 * This is the guard in front of the public execution path. A wallet address
 * (`otl_…`) reaching here is refused, which is the specific mistake the
 * reference warns produces an inscrutable deserialization error.
 */
export function requireAccountComponent(value: string, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AddressDomainError('ACCOUNT_COMPONENT', 'OTHER', String(value), field);
  }
  const domain = classifyAddress(value);
  if (domain === 'WALLET_ADDRESS') {
    throw new AddressDomainError('ACCOUNT_COMPONENT', domain, value, field);
  }
  if (domain !== 'ACCOUNT_COMPONENT' && domain !== 'OTHER') {
    throw new AddressDomainError('ACCOUNT_COMPONENT', domain, value, field);
  }
  return value;
}

/**
 * Assert that a value is a WALLET ADDRESS, for addressing a private/stealth
 * output.
 *
 * An account component address reaching here is refused. The reference is
 * explicit that a stealth destination decodes as a bech32m wallet address, and
 * "never address a stealth/private output to the account component" is a
 * correctness requirement, not a style preference.
 *
 * NOTE: a resource address also begins `otl_`, so this guard cannot separate the
 * two from the string alone. It exists to catch the definite mistake (a
 * `component_…` value) and to keep the required domain explicit at the call
 * site; a caller that already holds a tagged `Address` should pass `.value` from
 * `walletAddress()` so the intent is visible in the code.
 */
export function requireWalletAddress(value: string, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AddressDomainError('WALLET_ADDRESS', 'OTHER', String(value), field);
  }
  const domain = classifyAddress(value);
  if (domain === 'ACCOUNT_COMPONENT') {
    throw new AddressDomainError('WALLET_ADDRESS', domain, value, field);
  }
  return value;
}
