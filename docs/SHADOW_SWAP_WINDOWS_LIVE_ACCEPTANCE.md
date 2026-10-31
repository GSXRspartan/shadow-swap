# Shadow Swap — Windows Live Acceptance (walletd + real browser wallet)

For the operator, on the Windows machine that runs `tari_ootle_walletd`. Nothing here was
executed by the cloud campaign: the cloud cannot and must not reach `127.0.0.1:5100`.

**Ground rules**

- Use a **disposable** Esmeralda account with a small tTARI balance. Never a seed, view key
  or wallet database that matters.
- Never expose walletd beyond loopback. Never paste a seed, key, JWT or cookie anywhere.
- Every write is **one** approval in the wallet UI, by you. If anything is ambiguous, stop and
  reconcile (step 10) before trying again — never "click submit again".
- Record every transaction id in `tools/live-executor/live-op-ledger.jsonl` (append only).

---

## 1. Walletd version and network

Ootle v0.48.0 is a **reset** release: a 0.47 or older walletd cannot join the reset network,
and a 0.48 walletd needs a **fresh** data directory.

```powershell
# Back up first (copy, do not move). Keep the backup until acceptance is complete.
Copy-Item -Recurse "$env:APPDATA\tari\ootle\esmeralda" "$env:USERPROFILE\ootle-esmeralda-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"

# Verify the binary you downloaded against the release's published checksum.
Get-FileHash .\tari_ootle_walletd-0.48.0-*-windows-x64.exe -Algorithm SHA256
```

Start walletd on loopback only, then:

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"wallet.get_info","params":{}}'
Invoke-RestMethod -Uri http://127.0.0.1:5100/json_rpc -Method Post -ContentType 'application/json' -Body $body
```

Expect `version 0.48.x`, network `esmeralda`, network byte `38`. These calls assume the
loopback, no-auth setup recorded in CHECKPOINT B2 (`--authentication none`, 127.0.0.1 only).
v0.48 walletd also offers cookie-file authentication (`<base_path>/.cookie`); if you enable it,
authenticate locally with that cookie and never copy it off the machine. Note: v0.48 walletd defaults
to `indexer_trust = "trust"`; set `"verify"` if you want the wallet to verify indexer
receipts and substates itself.

## 2. Read-only network and resource inventory

```powershell
foreach ($h in 'esme-indexer-a.ootle.tari.com','esme-indexer-b.ootle.tari.com','ootle-indexer-a.tari.com') {
  try { Invoke-RestMethod "https://$h/info" | Select-Object version,network,network_byte,current_epoch,verify_substate_proofs } catch { "$h : $($_.Exception.Message)" }
}
Invoke-RestMethod https://esme-indexer-a.ootle.tari.com/resources/tari | Select-Object version   # value is base64 CBOR on v0.48
```

Record: which hosts answer, their versions, whether `verify_substate_proofs` is true, and the
epoch. **If the v0.48 hosts answer `0.48.x`, the pre-reset Pool v2 and marketplace components
no longer exist** and no Shadow Swap template is published there yet (see step 4).

Account balances, read-only:

```powershell
$body = '{"jsonrpc":"2.0","id":2,"method":"accounts.get_balances","params":{"account":null,"refresh":true}}'
Invoke-RestMethod -Uri http://127.0.0.1:5100/json_rpc -Method Post -ContentType 'application/json' -Body $body
```

## 3. Browser extension connection

1. Install Sapient from its GitHub release (or Chrome Web Store) — note the version.
2. Create or import a **disposable** account; select **Esmeralda**.
3. Open the Shadow Swap build (local `pnpm --filter @tari-ootle/web preview`, or the Cloudflare
   preview URL). Wallet-provider detection requires HTTPS or `http://localhost`.
4. Connect. Confirm the header shows **Esmeralda Testnet**, the indexer version, and the
   connected account. Open DevTools → Console: there must be no CSP violation.

Expected on the **reset** network until templates are published: "Network reachable, protocol
not yet deployed" with the generation stated. That is a correct result, not a failure.

## 4. (Operator decision) publish the v0.48 templates

Only if you decide to. Build reproducibly and confirm the hashes first:

```bash
tools/build-templates.sh --check     # must print "reproducible: hashes match" (now 5 templates, incl. p2p_offer)
```

Publish each WASM from that build through walletd v0.48.0 `transactions.publish_template`
(dry-run first, then real). Do NOT try to publish the raw file by any other route: the v0.48
engine rejects custom sections other than `tari_tdef`, and walletd's built-in `wasm-opt`
(0.116.1) pass is what strips them, so the published bytes are walletd's optimised output.
Verify the published address and binary as described in
`docs/SHADOW_SWAP_P2P_SWAPOFFER_BROWSER.md` §8, then record the addresses in
`apps/web/src/services/protocolDeployment.ts` (`V048_RESET`: `poolTemplates`, marketplace,
`offerTemplates`). Before publishing the Pool, switch the add-liquidity builder to
`add_liquidity_exact` (release blocker 3).

## 5. Minimal disposable swap

Create (or use) a small pool from a **recorded** v0.48 Pool template, then swap a tiny amount:

- public fungible → public fungible works with any account type;
- **tTARI as the input** through a Sapient **seed (local)** account now goes through the
  wallet's native `withdrawStealthAndExecute` request (the approval card shows a Stealth
  withdrawal, not an instruction list); a daemon-relayed account keeps the plain path. Record
  both; the follow-up workspace-id convention is real-wallet-unverified until this step passes.

Before approving, compare the app's review (pool, input, min output, fee 30 bps, slippage)
with the wallet's approval card. They must agree exactly.

## 6. Actual wallet approval

Approve once in the wallet popup. The app must show **pending approval**, then **submitted**.
Do not click anything twice.

## 7. Submission-once guarantee

While the approval is pending, reload the page. The app must resume the **same** request id,
not create a new one. After approval, check walletd / the indexer: exactly one transaction.

## 8. Finality

The status must end **Confirmed** only when the execution result is `Accept`. A fee-only commit
(`AcceptFeeRejectRest`) must show **Rejected — only the fee was taken**, never Confirmed.

## 9. Before/after reconciliation

Record balances before and after. Reconcile: input spent + fee == decrease; output received ≥
the reviewed minimum; pool reserves moved by the same amounts; k increased (fee retained by
LPs). Any unexplained difference is a stop-ship finding.

## 10. Reload / resume and ambiguous results

- Close the tab mid-approval, reopen: the pending request is recovered from storage.
- If a result is **UNKNOWN** (timeout, provider gone): do **not** resubmit. Look the id up via
  `tari_getTransactionResult` / the indexer; only a definite **REJECTED/aborted** permits a new
  attempt.

Record outcomes against release gates **F**, **G** and **I** in
`docs/SHADOW_SWAP_V047_RELEASE_READINESS.md` §9.

## 11. P2P offers (Phase 2)

Once a SwapOffer template is recorded, run the ten steps in
`docs/SHADOW_SWAP_P2P_SWAPOFFER_BROWSER.md` §10 (fungible offer, forged invitation, designated
taker + hash lock, expiry/cancel, NFT barter, tTARI from seed and relayed accounts, created-Stealth
offer, reload during approval).

