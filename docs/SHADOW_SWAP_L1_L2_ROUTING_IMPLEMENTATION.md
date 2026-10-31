# Minotari (L1) ↔ Ootle (L2) routing — what the protocol supports

Cohort tari-ootle **v0.48.0** (`6a25dbc`). Code: `packages/protocol-client/src/crossLayer/burnClaim.ts`,
`apps/web/src/components/CrossLayerPanel.tsx`, page `/cross-layer`.
Tests: `apps/web/test/cross-layer-burn-claim.test.cjs` (9/9).

## 1. Summary

| Direction | Status |
|---|---|
| **L1 → L2 conversion (burn and claim)** | A real upstream protocol. Every step Shadow Swap can do is **IMPLEMENTED**; the claim transaction itself is **BLOCKED BY UPSTREAM** for browser wallets and is performed by the user's own wallet. |
| **L2 → L1** | **BLOCKED BY UPSTREAM — no such route exists.** §5 names the two missing primitives. |
| **L1 ↔ L2 atomic HTLC swap** | **BLOCKED BY UPSTREAM** on the L1 leg; unchanged from `TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md`. |

**This is a one-way, multi-stage conversion, not an atomic swap.** The L1 burn is irreversible
the moment it confirms, and every later step can be delayed, fail or need recovery. Nothing in
the code or the UI calls it atomic, and there is no state that claims a burn was reversed.

## 2. Why the claim cannot be built by any dApp

From `applications/tari_walletd/src/handlers/accounts.rs::build_claim_burn_transaction`, the
claim needs, from the account's **secret** key:

1. the stealth spend secret `s = H(R·p) + p`, where `R` is the burn output's
   `sender_offset_public_key` and `p` the account owner secret. The burn names `S = s·G` as its
   claim key, and **the claim transaction must be signed by `s`**, not by the account key;
2. decryption of the burn output's `encrypted_data` with `p`, to recover the output's mask and
   value;
3. a fresh stealth output (mask, nonce, tag) for the claimed funds.

None of that is expressible as an instruction list, so `Instruction::ClaimBurn` cannot be
assembled from public data, and a dApp cannot hand a wallet a claim to sign. Sapient's
documented `WalletCapabilities` has **no** burn or claim field at all; `walletd` does expose
`accounts.claim_burn`.

Conclusion: the claim belongs to the user's own wallet. Shadow Swap must not — and cannot —
reach a local wallet daemon, and the page says so instead of implying otherwise.

## 3. What Shadow Swap does implement

1. **The burn destination.** The L1 burn must name the L2 account's public key `P`
   (`BurnClaimProof.burn_public_key`). That key is read from the account's **own component
   header** on chain (`owner_rule: { ByPublicKey }`), so the user transcribes nothing and a
   burn to a different key is detectable rather than discovered after the fact.
2. **Burn proof validation (structure only).** `parseBurnClaimProof` validates a file against
   upstream's `CompleteClaimBurnProof` schema (`crates/sidechain/src/burn_proof.rs`) and its own
   length caps — script and covenant 4098 bytes, `encrypted_data` 340, metadata signature 256,
   MMR proofs 64 hashes — and returns only public facts. It explicitly does **not** verify the
   ownership proof or the MMR inclusion: only the engine can, and the page says that.
3. **Whether it is claimable at all, and yet.** `verifyBurnClaim` refuses a proof made out to
   another account, an incomplete file, and a claim before the proof's `mined_in_epoch` — which
   upstream added precisely so a claimant can defer, because an earlier submission is
   **permanently rejected** while the burn is already irreversible. An unknown L2 epoch is a
   blocker, not an assumption.
4. **A durable, evidence-based state machine.**

| Stage | Reached from |
|---|---|
| `DESTINATION_READY` | the account's own public key was read from chain |
| `BURN_PROOF_LOADED` | a structurally valid proof |
| `AWAITING_L2_EPOCH` | valid, but L2 has not passed `mined_in_epoch` |
| `CLAIM_READY` | everything checkable agrees |
| `CLAIM_REPORTED_BY_USER` | **the user's word only** — named so it can never be shown as settlement |
| `CLAIMED_CONFIRMED_ON_CHAIN` | an **authoritative balance read** shows at least the burned value arrived; terminal |
| `BLOCKED` | a checkable term disagrees; the reasons are carried |

   There is no reversal stage, because an L1 burn cannot be reversed. A balance that has not
   risen enough leaves the stage alone, so a hopeful read never completes a conversion.
5. **Nothing secret persisted.** The durable record holds a commitment, a value, a block hash
   and an epoch — all public chain data. `assertNoSecrets` refuses any field whose name matches
   encrypted data, a mask, a seed, a mnemonic, a private/view/spend/signing key, an ownership
   proof or a preimage, and the panel's storage path goes through it. The proof file's
   `encrypted_data` and ownership proof never leave the parser, are never stored and are never
   put in a URL.
6. **Trade afterwards.** Once confirmed, the claimed XTR is ordinary account balance and every
   existing route trades it; no special path is needed or offered.

## 4. Operator / user procedure

1. Open `/cross-layer` with the L2 wallet connected. Copy the burn destination shown (the
   account's own public key).
2. In a **base-layer** wallet, burn the intended XTM naming that key. This step is outside
   Shadow Swap and is irreversible.
3. Load the proof the burn produced (paste or file). The page reports the value, the
   destination, the L1 block, and whether L2 has synced far enough.
4. Claim it with your own walletd — dry run first:

```json
{"jsonrpc":"2.0","id":1,"method":"accounts.claim_burn",
 "params":{"account":"<your L2 account>",
           "claim_proof":{"FromFile":{"file_name":"<file in walletd's burn proof dir>"}},
           "max_fee":"<cap in XTR>","dry_run":true}}
```

   Then repeat with `"dry_run": false`. This needs a token with that account's own authority,
   because the claim is signed by a key derived from your account secret.
5. Press "Check for the claimed funds". Only an on-chain balance read marks it complete.

## 5. L2 → L1: the missing primitives

The complete v0.48 instruction set is `CreateAccount`, `CallFunction`, `CallMethod`,
`PutLastInstructionOutputOnWorkspace`, `ClaimBurn`, `ClaimValidatorFees`,
`DropAllProofsInWorkspace`, `Assert`, `TakeFromBucket`, `PublishTemplate`, `AllocateAddress`,
`StealthTransfer`, `PayFeeFromBucket`, `UpdateComponentTemplate`, `PutIntoBucket`.

`ClaimBurn` is strictly one-way. There is no L2-side burn or exit instruction, and no base-layer
verifier that would accept an L2 commitment proof. `tari_watcher` is validator-node registration
tooling, not a bridge. Searching upstream for a peg-out, exit, withdrawal or L1-release path
returns nothing.

**Missing, exactly:**

1. an L2 instruction that destroys or escrows value and emits a consensus-attested, provable
   exit receipt;
2. a base-layer verifier that accepts that receipt and releases L1 funds.

Both are protocol-level additions. Until they exist, anything labelled "L2 → L1" would be an
operator holding the L1 funds and releasing them on trust — a custodial bridge. This project
will not build that, so the direction stays **disabled**, and `/cross-layer` states the reason
rather than leaving a dead control.

### A bilateral cross-layer HTLC is also not available

A SHA-256 hash lock in an L2 template is not a cross-chain protocol: both chains must enforce
the hash lock and a safe refund timeout. The L2 leg exists (engine-verified hash locks, and
Sapient's `htlcFund`/`htlcClaim`/`htlcRefund`), but the L1 leg has no scripted-output
construction in any browser-reachable wallet API — the finding in
`TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md` still stands. Nothing here changes that, and no
`send()` fallback is used: a one-sided payment cannot be an HTLC.

## 6. Verification level

**IMPLEMENTED, REQUIRES REAL WALLET AND REAL L1 TEST.** The parsing, destination derivation,
epoch logic, state machine and receipt confirmation are unit-tested against engine-produced
account state, but no real burn was performed and no claim was submitted: that spends real
funds irreversibly and is the operator's decision. `SHADOW_SWAP_WINDOWS_LIVE_TESTS.md` §5 has
the observation-only procedure.
