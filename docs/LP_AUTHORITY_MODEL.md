# LP Token Authority Model

## Overview

This document describes the security model for LP (Liquidity Provider) token minting and burning authority in the fungible pool template.

## LP Token Creation

The LP token is created during pool initialization using `ResourceBuilder::public_fungible()`:

```rust
let lp_resource = ResourceBuilder::public_fungible()
    .with_token_symbol("LP")
    .with_divisibility(18)
    .burnable(AccessRule::DenyAll, UpdateRule::Locked) // Only component can burn via component logic
    .build();
```

Key properties:
- **Divisibility**: 18 (standard for fungible tokens)
- **Symbol**: "LP"
- **Mint Authority**: Implicitly restricted to the component that holds the `ResourceManager` reference
- **Burn Authority**: `AccessRule::DenyAll` with `UpdateRule::Locked` — no external caller can burn, only the component itself can burn via `lp_bucket.burn()` calls within its methods

## Mint Authority

### How Minting Works

The component mints LP tokens by calling:
```rust
ResourceManager::get(self.lp_resource).mint_fungible(amount)
```

This call succeeds because:
1. The `ResourceManager` is obtained via `ResourceManager::get(self.lp_resource)` where `self.lp_resource` is the LP resource address stored in the component state
2. The component has the authority to call `mint_fungible` on this resource because it was the creator of the resource (via `ResourceBuilder::build()`)
3. In Ootle, the component that creates a resource via `ResourceBuilder` implicitly gains mint/burn authority through the component's execution context

### Who CAN Mint

- **Only the Pool Component**: The `add_liquidity` method is the only code path that calls `mint_fungible`
- The method is public (`AccessRule::AllowAll`) but internally validates that:
  - Both input buckets match the pool's resource pair
  - Amounts are non-zero
  - Reserves are updated correctly before minting

### Who CANNOT Mint

| Attacker | Why Blocked |
|----------|-------------|
| External transaction caller | No direct access to `ResourceManager::get(lp_resource).mint_fungible()` — not a component method |
| Pool creator (after initialization) | No special badge/authority retained; creator is just a regular caller |
| Random account | No access to component's internal `lp_resource` reference |
| Unrelated component | Cannot access this component's `lp_resource` field; no cross-component mint authority |
| Constructor badge | No badge is created or distributed during pool creation |

### Proof of Isolation

1. **No badge/owner rule**: The LP resource has no `OwnerRule` set during creation (defaults to `OwnerRule::None`), so there's no admin badge that could be used for minting.

2. **No access rule for mint**: The `ResourceBuilder` does not set a custom `mintable` access rule — it uses the default which restricts minting to the resource creator (the pool component).

3. **Component isolation**: The `lp_resource` field is private to the `Pool` struct. No public method exposes it in a way that allows external minting.

4. **Method-level access**: The only method that mints is `add_liquidity`, which requires valid input buckets matching the pool's resources.

## Burn Authority

### How Burning Works

The component burns LP tokens by calling:
```rust
lp_bucket.burn()
```

This works because:
1. The caller provides an LP `Bucket` (obtained from a previous `add_liquidity` call or transfer)
2. The component calls `burn()` on that bucket
3. Since the LP resource has `burnable(AccessRule::DenyAll, UpdateRule::Locked)`, the burn succeeds only because it's called from within the component's execution context (which has implicit authority as the resource creator)

### Who CAN Burn

- **Only the Pool Component**: The `remove_liquidity` method is the only code path that calls `lp_bucket.burn()`
- The method validates:
  - The input bucket is the correct LP resource
  - The amount is non-zero
  - Proportional reserves are calculated correctly

### Who CANNOT Burn

| Attacker | Why Blocked |
|----------|-------------|
| External caller with LP tokens | `burnable(AccessRule::DenyAll)` prevents direct burn; must go through `remove_liquidity` |
| Pool creator | No special authority |
| Any other component | No cross-component burn authority |

## First Deposit Locked Liquidity

On first deposit, the component:
1. Calculates `initial_shares = floor(sqrt(amount_a * amount_b))`
2. Mints `initial_shares` total LP tokens
3. Immediately burns `MINIMUM_LOCKED_LIQUIDITY` (1000) shares from the minted bucket
4. Returns the remaining `initial_shares - MINIMUM_LOCKED_LIQUIDITY` to the first LP

This ensures:
- `MINIMUM_LOCKED_LIQUIDITY` shares are **permanently locked** — they are burned immediately after minting
- Total supply = `initial_shares - MINIMUM_LOCKED_LIQUIDITY` (for fair accounting)
- No mechanism exists to recover the locked shares:
  - No admin badge/key exists
  - No `mint_lp` method exists
  - No upgrade path exists
  - The burn is executed in the same transaction as the mint, atomically

## Reserve Withdrawal Authority

Reserves can only be withdrawn through:
1. **`swap()`**: Withdraws output tokens after depositing input tokens (with fee retained in pool)
2. **`remove_liquidity()`**: Withdraws proportional reserves after burning LP shares

There are NO methods for:
- `admin_withdraw`
- `emergency_withdraw`
- `recover`
- `drain`
- `set_vault`
- `set_recipient`
- `set_resource`
- `set_fee`
- `upgrade`

## Access Rules Summary

| Method | Access Rule | Notes |
|--------|-------------|-------|
| `add_liquidity` | `AllowAll` | Validates input buckets internally |
| `swap` | `AllowAll` | Validates input/output resources |
| `remove_liquidity` | `AllowAll` | Validates LP resource and amount |
| `get_pool_balances` | `AllowAll` | Read-only |
| `get_pool_balance` | `AllowAll` | Read-only |
| `lp_resource` | `AllowAll` | Read-only |
| `lp_total_supply` | `AllowAll` | Read-only |
| `locked_lp_supply` | `AllowAll` | Read-only |
| `fee_bps` | `AllowAll` | Read-only (basis points; 30 = 0.30%) |
| Default (all other methods) | `DenyAll` | No other methods exposed |

## Security Guarantees

1. **No privileged identity exists after initialization** — The pool is immutable after creation
2. **LP minting is bound to reserve deposits** — Every LP share minted corresponds to actual reserves added
3. **LP burning is bound to reserve withdrawals** — Every LP share burned corresponds to actual reserves withdrawn
4. **First-depositor attack prevented** — Geometric mean initialization + locked minimum liquidity
5. **No hidden protocol fees** — 100% of trading fees (0.30% default) stay in reserves, increasing LP value
6. **No upgrade authority** — Template is deployed as-is, no admin key

## Verification

These guarantees can be verified by:
1. **Code inspection**: No mint/burn calls outside `add_liquidity`/`remove_liquidity`
2. **Engine tests**: Attempting unauthorized mint/burn/withdrawal via `tari_template_test_tooling`
3. **ABI inspection**: No admin/privileged methods in exported interface