# Minotari L1 authority model — FAST_XTM_TARI

Status: **TESTNET / EXPERIMENTAL.** This document classifies, field by field, which source
may legitimately establish a fact about a Minotari SHA atomic-swap output, and what
remains unprovable today.

Traced against `C:\tmp-tari-l1` — `tari-project/tari` **v6.0.0**, commit
`97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3`, network Esmeralda.

---

## 1. The four sources, and what each one is allowed to assert

| Source | What it physically is | May establish |
|---|---|---|
| **BASE_NODE** | `base_layer/core/src/base_node/rpc/mod.rs` — the wallet RPC (`t/bnwallet/1`): `submit_transaction`, `transaction_query(kernel, excess_sig)`, `fetch_matching_utxos` / UTXO queries, `query_deleted`, `get_tip_info`. It serves the node's own view of the chain. | Output existence, the raw `TransactionOutput` (script bytes, commitment, features, covenant), mined height, confirmations, tip height, spent/deleted status, kernel excess/signature for a submitted transaction. |
| **FUNDING WALLET (us)** | `minotari_console_wallet` holding the private key that funded the output. It keeps the output in its own output manager with `SpendingPriority::HtlcSpendAsap` (`transaction_service/service.rs:2289`) and retains the value and blinding factor it committed. | What IT funded (its own output), and a chain-validated opening of that output's commitment. Not anything about a counterparty-funded output. |
| **CLAIMANT WALLET (peer)** | The wallet whose key the stealth output is addressed to. It derives the shared secret and decrypts the output's `EncryptedData`. | Nothing, in our protocol. It is the counterparty. |
| **PEER / PROVIDER ASSERTION** | Anything a remote service tells us without a chain read. | **Nothing.** Never settlement evidence (`PROVIDER_ASSERTION` is refused everywhere). |

---

## 2. Field-by-field authority

### 2.1 `script` (the raw TariScript bytes) — **BASE_NODE authoritative**

`TransactionOutput.script` is public data. The base node returns it verbatim; we decode it
with `decodeShaHtlcScript` and re-derive `H`, the claim key, the refund key, and the refund
height from those bytes. Nothing in the script is secret and nothing in it is trusted from
the wallet's say-so.

- The decode is exact: the traced opcode sequence only, no trailing bytes, and a varint that
  must decode to the same u64 the engine would compute.
- The real script is built by `TransactionService::send_sha_atomic_swap_transaction` and has
  the exact shape
  `HashSha256 PushHash(H) Equal IfThen PushPubKey(claimant) Else CheckHeightVerify(tip+720) PushPubKey(sender) EndIf`.
- **Provider behaviour:** `MinotariDevGrpcProvider.observeHtlc` sets `hashHex`,
  `claimRecipient`, `refundRecipient`, and `refundHeight` **only** from the decoded
  on-chain script. If the script cannot be decoded, all four are `undefined` and the
  coordinator fails closed.
- **Test:** `5.1`, `5.2`, `5.4`, `6.1`, `6.2`.

### 2.2 `H` (the hashlock) — **BASE_NODE authoritative**

`H` is `PushHash(H)` inside the public script. When the quote did not fix `H` (the real
Minotari wallet generates `S` internally, so the initiator learns `H` only afterwards), the
coordinator binds `H` from the first authoritative script readback — never from the peer's
message.

**Two independent paths, both must agree:**
1. the wallet-returned preimage, hashed locally: `H = SHA256(S)`, and
2. the `PushHash` value decoded from the on-chain script.

`ingestWalletGeneratedSecret` throws if a wallet-generated `H` disagrees with an already
accepted quote `H`; `L1_FUND_ACKNOWLEDGED` throws if it disagrees with a bound `H`. The
claim itself re-verifies `SHA256(S) == H` before anything irreversible happens.

- **Tests:** `8.1`, `8.2`, `14.2`, `10.3`, `23.2`.

### 2.3 `refund key` — **BASE_NODE authoritative, wallet-derived by construction**

The refund branch is the **funding wallet's own one-sided spend key**
(`RecipientScriptKey::OwnSpendKey`, `transaction_service/service.rs:2260`). It is not a
caller parameter: `SendShaAtomicSwapRequest` carries only `recipient`.

- `L1HtlcFundingIntent.refundRecipient` is therefore **documented as informational and never
  transmitted**. It is not a security input.
- The only trustworthy refund identity is `obs.refundRecipient`, re-decoded from the
  observed script.
- Our provider never constructs a refund against a caller-supplied key;
  `constructRefund` refuses unless the output is in **this** wallet's output manager, which
  is the local proof that we are the funder.
- **Tests:** `6.1`, `6.2`, `12.3`.

### 2.4 `refund height` — **BASE_NODE authoritative, and must be FRESH**

The real wallet hardcodes `tip + BLOCKS_PER_DAY` (`24*30 = 720` blocks) and exposes no
parameter. The authoritative height is the `CheckHeightVerify` operand decoded from the
script, cross-checked against the quote **and** against the current tip.

**Both checks are required** (a match with the quote alone is not enough — the latter was a
MEDIUM finding fixed in this audit):
- `deadlineSafe`: `obs.refundHeight === record.l1RefundDeadlineHeight`, and
- `deadlineFresh`: `obs.refundHeight > obs.currentHeight + requiredL1Confirmations`.

Without the second check, an output that is *already* refundable could pass verification and
the counterparty could take the first leg back immediately after the second leg is funded.
- **Tests:** `6.2`, `15.2`, and `crosschain.test.cjs` "refund height 500 at tip 510 is NOT fresh".

### 2.5 `spend status` — **BASE_NODE authoritative**

Unspent = present in the UTXO set; spent = absent but returned by the deleted/spent query
(`query_deleted`). The provider distinguishes these and never reports "not found" as
"unspent".

- **Tests:** `12.2` (spent observation), `17.1` (a vanished output is caught at arm time),
  `10.2(e)` (a spent L2 output refuses arming).

### 2.6 `confirmation status` — **BASE_NODE authoritative, re-checked at arm time**

`confirmations = tipHeight − minedHeight + 1`, compared against
`requiredL1Confirmations`. The value is re-observed at `armClaim`, so a finality regression
between funding and arming is caught rather than trusted from the earlier read.

- **Tests:** `10.2(d)`, `17.1`.

### 2.7 `amount` — **NOT PROVABLE BY THE BASE NODE. This is the critical boundary.**

A stealth one-sided output stores its value inside a **blinded commitment**. The base node
returns the `TransactionOutput` with the commitment and the Bulletproof range proof — not a
revealed value. The base node physically cannot tell us the amount.

**What legitimately makes `amountAuthoritative = true`**

Two parties can establish it, using the *same* real APIs the claim path already uses
(`output_manager_service/service.rs:2841-2856`):

1. **As the CLAIMANT**, from chain data + our own private key:
   - `EncryptedData::decrypt_data(encryption_key, output.commitment, output.encrypted_data)`
     returns `(MicroMinotari, PrivateKey /* blinding factor */, MemoField)`
     (`base_layer/transaction_components/src/transaction_components/encrypted_data.rs:136`);
   - `encryption_key` is derived from
     `DH(our view key, output.sender_offset_public_key)` — the key the output is addressed
     to, which we hold precisely because we are the claimant;
   - then `output.verify_mask(&range_proof, &spending_key, amount.as_u64())`
     (`transaction_output.rs`) validates the decrypted value against the on-chain commitment
     and Bulletproof.
   - The result is a **cryptographic opening of an on-chain commitment**, not an assertion.
2. **As the FUNDER**, for our own output: we hold the value and blinding factor we committed,
   and can run the same `verify_mask` against the published commitment, cross-checked with our
   own output-manager record.

**Why our current provider reports `amountAuthoritative: false`**

`MinotariDevGrpcProvider` is a *remote gRPC client*. It can only see what the traced wallet
gRPC surface exposes, and the traced `wallet.proto` has **no RPC that returns a decrypted,
range-proof-verified amount for an arbitrary output hash**. `GetBalance` returns wallet
totals, not per-output values. The readback port therefore cannot honestly populate
`amountRaw`, so it leaves it absent and sets `amountAuthoritative: false`.

**The coordinator's behaviour is to refuse, not to guess**

- `verifyL1Funded` computes `amountExact = obs.amountRaw === record.xtmRawAmount && amountAuthoritative`,
  where `amountAuthoritative = obs.amountAuthoritative === true`. A remembered intent
  amount is explicitly *not* proof.
- `applyEvent` refuses to stamp `l1Verification` unless `amountAuthoritative` is true, so
  the second leg cannot be funded and the claim cannot be armed without a proven amount.
- **Tests:** `crosschain.test.cjs` "authoritative L1 verification refuses a merely-remembered
  amount" (blinded → refused; proven + fresh → verified and stamped), `minotari.test.cjs`
  ("refuses to call a blinded amount authoritative", "a readback adapter that CAN prove the
  amount reports it as authoritative").

**Directional risk**

| Direction | Who funds L1 | Who must verify the amount | Adversarial? |
|---|---|---|---|
| `XTM_TO_TARI` | us | ourselves (funder self-consistency) | no — we chose the amount |
| `TARI_TO_XTM` | the counterparty | us, as claimant, via decryption + `verify_mask` | **yes** — this is the drain vector if skipped |

**Verdict: EXTERNAL_RISK, not a protocol impossibility.** The cryptography exists and is
already used by the real claim path; what is missing is an API surface (wallet RPC or WASM
operation) that performs the decryption and proof *and* reports it. This is an upstream
extension requirement, recorded in
`docs/TARI_BROWSER_SHA_SWAP_UPSTREAM_PLAN.md` §5 and in the residual-risk register. Until it
exists, the coordinator correctly refuses to complete a counterparty-funded L1 leg.

---

## 3. What the funding wallet may assert about a peer-funded output

**Nothing.** A funding wallet's `GetTransactionInfo`, `GetBalance`, and output-manager
contents describe *its own* wallet. `lookupTransaction` is used only for UNKNOWN
reconciliation, and a `WALLET_OUTPUT_MANAGER` source is explicitly documented as
"sufficient for refund construction, never for counterparty funding proof".

## 4. Residual authority gaps

| Gap | Effect today | Classification |
|---|---|---|
| No RPC/WASM path returns a decrypted, range-proof-verified amount | Counterparty-funded L1 legs cannot be verified → coordinator refuses to advance | EXTERNAL_RISK (fixable upstream) |
| The base node cannot reveal values at all | Nothing may be inferred from a commitment alone | N/A_BY_CONSTRUCTION |
| `MinotariDevGrpcProvider.fundings` is in-memory | A restart loses the tx→output-hash association; recovery must re-derive it from the wallet's own output manager | EXTERNAL_RISK (dev provider only) |
| `primitivesStatus()` reflects wiring, not a live `GetVersion` handshake | A provider could be wired to an unexpected wallet version | LOW (documented) |
| No concrete tonic/base-node client is committed | Nothing here has been exercised against a live node | BLOCKED_EXTERNAL |
