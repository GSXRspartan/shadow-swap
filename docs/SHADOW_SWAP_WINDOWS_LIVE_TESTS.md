# Windows live tests (Phase 3)

The operator's Windows machine has walletd (historically `http://127.0.0.1:5100`). Claude Code
Cloud cannot reach it, and must not: nothing here asks for a seed, a view key or a token.

**Before anything:** detect what is installed instead of assuming, and never upgrade or reset a
wallet database that holds value.

```powershell
# Which walletd is this, and which network does it serve?
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5100 -ContentType application/json `
  -Body '{"jsonrpc":"2.0","id":1,"method":"rpc.discover","params":{}}' |
  ConvertTo-Json -Depth 4 | Select-Object -First 40

# The L2 network's own answer (run from any machine with egress):
Invoke-RestMethod https://esme-indexer-a.ootle.tari.com/info
Invoke-RestMethod https://esme-indexer-b.ootle.tari.com/info
```

Expect `0.48.x`. A mismatch stops everything: the templates in this repo are built for the
v0.48.0 cohort.

Use **disposable** accounts and assets. Do not start a second daemon on a data directory that is
already in use.

## 1. Prerequisites

| Item | Why |
|---|---|
| walletd **v0.48.0** | the reset network's genesis and sr25519 signing |
| Current Sapient release | the browser paths: transaction requests and `withdrawStealthAndExecute` |
| Two disposable accounts | maker and taker |
| Published + recorded templates | nothing new is executable otherwise (`SHADOW_SWAP_UNIVERSAL_TRADING_MATRIX.md` §6) |

## 2. Public AMM (regression, unchanged by Phase 3)

Run the existing list in `SHADOW_SWAP_WINDOWS_LIVE_ACCEPTANCE.md` §5–§10: a direct swap, a
two-hop and a three-hop route, pool creation, LP deposit and withdrawal, approval reload and the
ambiguous-result rule.

**Carry forward one correction:** pool creation must keep using `add_liquidity`.
`add_liquidity_exact` **cannot serve a first deposit** (`pool_engine` `e07e`: its empty refunds
use `Bucket::take(0)`, which template_lib refuses). Switching the builder wholesale would break
creation.

## 3. P2P offers

Run `SHADOW_SWAP_BROWSER_P2P_ACCEPTANCE.md` end to end: create, share, import, forged
invitation, designated taker, hash lock, expiry, cancel, NFT barter, and a reload mid-approval.
Also confirm the item picker lists exactly the NFTs the account holds, and nothing else.

## 4. Revealed-value pools (new)

Only with a `RevealedAssetPool` recorded.

| # | Case | Expected |
|---|---|---|
| 4.1 | Pools page → "Transparent pools" | The transparency notice is shown before any control |
| 4.2 | Create a pool from a created-Stealth balance and a public fungible | One transaction; LP and both refunds deposited; the lock is ≤1% of the position and shown beforehand |
| 4.3 | A dust first deposit | Refused in the browser with the share-policy message, before the wallet |
| 4.4 | Swap Stealth → public in that pool | Output matches the quote; the Stealth reserve stays a Stealth container |
| 4.5 | Swap public → Stealth | The Stealth-typed asset arrives in the account, type unchanged |
| 4.6 | Add liquidity with an imbalanced pair | Only the balanced part is taken; the remainder is refunded in the same transaction |
| 4.7 | Withdraw liquidity | Both sides arrive; the on-chain exit minimums appear as real call arguments in the wallet card |
| 4.8 | A Confidential balance with blinded commitments | Refused (never silently partially accepted) |
| 4.9 | tTARI from a **Sapient seed** account into a revealed pool | The approval is a **Stealth withdrawal**, not an instruction list. **This is the first real-wallet check of the follow-up workspace-id derivation** — record the result either way |
| 4.10 | The same from a **walletd-relayed** account | The plain withdrawal path; record it |
| 4.11 | A mixed route (transparent hop then public hop) | Quoted on `/swap`; it is shown but not signable from that page in this build — confirm the page says so rather than offering a dead button |

## 5. L1 → L2 conversion (observation only until you decide to spend)

**Do not burn real funds to satisfy a test.** A burn is irreversible.

| # | Case | Expected |
|---|---|---|
| 5.1 | `/cross-layer` with a wallet connected | The burn destination is this account's own public key, read from chain; the network and current epoch are shown |
| 5.2 | Load a burn proof made out to a **different** account | Refused, naming both keys; no claim offered |
| 5.3 | Load a structurally broken proof (truncate a hash, oversize the script) | Refused with the specific field |
| 5.4 | Load a valid proof whose `mined_in_epoch` is ahead of L2 | "Not claimable yet", with the warning that an early claim is permanently rejected |
| 5.5 | A valid, claimable proof | The page shows the walletd `accounts.claim_burn` call and states plainly that Shadow Swap cannot submit it |
| 5.6 | *(Only if you choose to convert)* run the claim in walletd, dry run first | Then "Check for the claimed funds": the stage must reach confirmed **only** from the balance read |
| 5.7 | Reload the page at any stage | The stage is recovered; no secret was stored (inspect local storage: a commitment, a value, a block hash and an epoch) |
| 5.8 | The L2 → L1 section | States that no such route exists and why. There must be no control suggesting otherwise |

## 6. Recording results

Record each against release gates **F**, **G** and **I** in
`SHADOW_SWAP_V047_RELEASE_READINESS.md` §9, and update the verification level of each row in
`SHADOW_SWAP_UNIVERSAL_TRADING_MATRIX.md` from "ENGINE VERIFIED" or "IMPLEMENTED, REQUIRES REAL
WALLET TEST" to "LIVE VERIFIED" **only** with a recorded transaction id and reconciled balances.
