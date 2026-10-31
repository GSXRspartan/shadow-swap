/**
 * Stealth-typed inputs (native tTARI, created-Stealth resources) at the wallet boundary.
 *
 * Sapient's seed-derived local accounts cannot sign a plain `Account::withdraw` of a
 * Stealth-typed balance: its client-side signer rejects it (tari-wallet
 * `background/index.ts`, "a plain CallMethod withdraw on a Stealth vault is not a
 * standalone-valid instruction"). Those accounts advertise `capabilities.stealthWithdraw` and
 * accept `{ kind: 'withdrawStealthAndExecute' }` instead: the wallet withdraws the revealed
 * amount through its own StealthTransfer and runs our follow-up instructions on the bucket.
 *
 * The engine itself accepts a plain withdraw of a revealed Stealth balance
 * (audit_engine_tests p10), which is why accounts WITHOUT `stealthWithdraw` -- walletd-relayed
 * accounts -- keep the existing `{ kind: 'instructions' }` path unchanged.
 *
 * FOLLOW-UP WORKSPACE IDS. Sapient appends follow-ups with `withInstructions`, which does no
 * name resolution, so they must use integer ids. Read from the shipped code
 * (@chironbuilder/ootle-sdk 0.1.30 `buildWithdrawStealthAndExecute` + its vendored builder's
 * `emitInstructions`): the account withdrawal is saved first (id 0), consumed by the
 * StealthTransfer, and the revealed output is saved under `workspaceVarName` next (id 1).
 * Follow-ups therefore reference the input as id 1 and allocate from id 2. This is derived
 * from source and NOT yet observed against a live wallet; it is pinned by tests here and listed
 * as a Windows-acceptance step.
 */

import { buildSignableInstructions, type TariInstruction } from '../lib/instructions.js';
import type { TariWithdrawStealthAndExecuteOperation } from './tariDappTypes.js';

export const SAPIENT_INTERNAL_WITHDRAW_WORKSPACE_ID = 0;
export const SAPIENT_REVEALED_BUCKET_WORKSPACE_ID = 1;

interface IntentInstruction {
  kind: string;
  accountAddress?: string;
  resourceAddress?: string;
  amount?: string;
  output?: { kind: 'workspace_bucket'; name: string };
  componentAddress?: string;
}

export type InputMode =
  | { mode: 'instructions' }
  | { mode: 'stealth'; resourceAddress: string }
  | { mode: 'blocked'; reason: string };

/**
 * Decide how the intent's input reaches the wallet.
 *
 * `stealthResources` are the resources the wallet reports as Stealth-typed (balances with
 * resourceType `stealth`, which includes native tTARI). A decision is never made from a
 * resource's name or symbol.
 */
export function planInputMode(instructions: readonly unknown[], ctx: { stealthResources: ReadonlySet<string>; capabilities?: Readonly<Record<string, boolean>> }): InputMode {
  const list = instructions as readonly IntentInstruction[];
  const withdrawals = list.filter((i) => i.kind === 'withdraw_fungible' || i.kind === 'withdraw_non_fungible');
  const stealthWithdrawals = withdrawals.filter((i) => i.kind === 'withdraw_fungible' && i.resourceAddress !== undefined && ctx.stealthResources.has(i.resourceAddress));
  if (stealthWithdrawals.length === 0) return { mode: 'instructions' };
  if (ctx.capabilities?.stealthWithdraw !== true) {
    // walletd-relayed accounts: unchanged behaviour (a plain withdraw, which the engine accepts).
    return { mode: 'instructions' };
  }
  if (ctx.capabilities.transactionRequests !== true) {
    return { mode: 'blocked', reason: 'This account can only move Stealth-typed funds through a wallet transaction request, and it does not advertise transaction requests.' };
  }
  const first = list[0];
  if (withdrawals.length !== 1 || first === undefined || first !== stealthWithdrawals[0]) {
    return {
      mode: 'blocked',
      reason:
        'Your wallet can move a Stealth-typed asset (tTARI or a created-Stealth token) into a contract only as the single input of a transaction, and it refuses any further withdrawal from your account in the same transaction. This operation withdraws more than one asset, so it cannot be signed from this account.',
    };
  }
  return { mode: 'stealth', resourceAddress: first.resourceAddress! };
}

/**
 * The `withdrawStealthAndExecute` operation for an intent whose FIRST instruction withdraws the
 * Stealth input. Built from the same intent the review is built from, so it cannot drift.
 */
export function buildStealthWithdrawOperation(instructions: readonly unknown[], account: string): { operation: TariWithdrawStealthAndExecuteOperation; followUps: TariInstruction[] } {
  const list = instructions as readonly IntentInstruction[];
  const first = list[0];
  if (first?.kind !== 'withdraw_fungible' || first.output === undefined || first.resourceAddress === undefined || first.amount === undefined) {
    throw new Error('A Stealth input must be the first instruction: a fungible withdrawal into a named bucket.');
  }
  if (first.accountAddress !== account) throw new Error('The Stealth input must be withdrawn from the connected account.');
  const rest = list.slice(1);
  if (rest.some((i) => i.kind === 'withdraw_fungible' || i.kind === 'withdraw_non_fungible')) {
    throw new Error('A Stealth-input transaction cannot withdraw anything else from the account.');
  }
  const followUps = buildSignableInstructions({
    instructions: rest,
    reservedWorkspace: new Map([
      ['__wallet_internal_withdraw', SAPIENT_INTERNAL_WITHDRAW_WORKSPACE_ID],
      [first.output.name, SAPIENT_REVEALED_BUCKET_WORKSPACE_ID],
    ]),
  });
  // Mirror of the wallet's own refusal (tari-wallet preview.ts `ownAccountCalls`): a
  // follow-up may only DEPOSIT into the account, so the approval bounds what is spent.
  for (const ins of followUps) {
    const call = (ins as { CallMethod?: { call?: { Address?: string }; method?: string } }).CallMethod;
    if (call?.call?.Address === account && !String(call.method).startsWith('deposit')) {
      throw new Error(`A Stealth-input follow-up may not call "${call.method}" on your own account.`);
    }
  }
  const related = new Set<string>();
  for (const ins of followUps) {
    const address = (ins as { CallMethod?: { call?: { Address?: string } } }).CallMethod?.call?.Address;
    if (address !== undefined && address !== account) related.add(address);
  }
  const operation: TariWithdrawStealthAndExecuteOperation = {
    kind: 'withdrawStealthAndExecute',
    resourceAddress: first.resourceAddress,
    amount: first.amount,
    workspaceVarName: 'shadow_swap_input',
    followUpInstructions: followUps,
    ...(related.size > 0 ? { relatedComponents: [...related].sort() } : {}),
  };
  return { operation, followUps };
}

/** Native tTARI: Stealth-typed by protocol, recognised by exact address only. */
const NATIVE_TARI = 'resource_0101010101010101010101010101010101010101010101010101010101010101';

/**
 * The review's `stealthInput` for this wallet, or `undefined` for the plain path. Throws the
 * exact reason when this account cannot sign the operation at all, so nothing is submitted.
 */
export function stealthInputFor(
  instructions: readonly unknown[],
  wallet: { balances: ReadonlyArray<{ resourceAddress: string; resourceType: string }>; walletCapabilities?: object },
): { resourceAddress: string } | undefined {
  const stealthResources = new Set(wallet.balances.filter((b) => b.resourceType === 'stealth').map((b) => b.resourceAddress));
  stealthResources.add(NATIVE_TARI);
  const caps = (wallet.walletCapabilities ?? {}) as Record<string, unknown>;
  const capabilities = { stealthWithdraw: caps.stealthWithdraw === true, transactionRequests: caps.transactionRequests === true };
  const plan = planInputMode(instructions, { stealthResources, capabilities });
  if (plan.mode === 'blocked') throw new Error(plan.reason);
  return plan.mode === 'stealth' ? { resourceAddress: plan.resourceAddress } : undefined;
}
