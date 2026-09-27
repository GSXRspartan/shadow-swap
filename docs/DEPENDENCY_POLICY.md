# Dependency and build reproducibility policy

## Canonical toolchain

| Tool | Version | Declared in |
|---|---|---|
| Node | 20 | `engines.node` in `package.json`; `setup-node` in both workflows; Cloudflare Pages build image |
| pnpm | **9.15.9** | `packageManager` in `package.json`; `engines.pnpm: ">=9.0.0 <10.0.0"`; `pnpm/action-setup` in both workflows |
| Lockfile | `lockfileVersion: '9.0'` | `pnpm-lock.yaml`, committed |

**pnpm 9 is canonical. pnpm 10 and 11 are not supported by this repository.**

The reason is not preference, it is the lockfile. `lockfileVersion: 9.0` is
readable by pnpm 9; a pnpm 10 or 11 install cannot consume it, so a silent major
bump cannot quietly re-resolve the dependency tree — it fails instead. The
`<10.0.0` engine bound makes that a visible failure at install time rather than
a different tree at build time.

Every surface agrees on 9.15.9:

- `packageManager: "pnpm@9.15.9"`
- `engines.pnpm: ">=9.0.0 <10.0.0"`
- `pnpm/action-setup` pinned to `9.15.9` in `pages.yml` and `node-tests.yml`
- the local development environment runs `pnpm 9.15.9`

If pnpm is ever upgraded, the upgrade is a deliberate change: regenerate the
lockfile with the new major, update all four of the above together, and run the
full suite. Changing one and not the others is the failure this policy exists
to prevent.

## npm is not a supported install path

`package-lock.json` was removed. It was a stale npm lockfile (`lockfileVersion`
3) last written before the pnpm migration, referenced by no workflow, and
declaring a *different* resolution than `pnpm-lock.yaml`. Its presence meant
that a developer running `npm install` would get a tree that no CI run had ever
verified — the precise failure `--frozen-lockfile` exists to prevent.

The only place npm appears in this repository is inside `apps/web/package.json`
**scripts**, as `npm run <script>`. Those are script invocations, not installs;
they execute whatever `packageManager` resolved. They are not an install path.

## Frozen installs everywhere

```bash
pnpm install --frozen-lockfile
```

Used by:

- `.github/workflows/node-tests.yml` (both jobs)
- `.github/workflows/pages.yml`
- the Cloudflare Pages build configuration, which must match CI exactly

`--frozen-lockfile` fails when `package.json` and `pnpm-lock.yaml` disagree. For
a project that builds transaction-construction code, an unreviewed dependency
change reaching a deployment is a security event, not a convenience.

## Adding or upgrading a dependency

```bash
pnpm --filter <package> add <dep>     # or: pnpm update <dep>
pnpm install --frozen-lockfile         # confirm the lockfile still satisfies the manifests
pnpm audit --prod --audit-level low    # no known vulnerabilities
```

The regenerated `pnpm-lock.yaml` is part of the change, not a side effect. A
dependency change without a lockfile change is not a complete change.

## Why the deployment must match CI

The testnet deployment is built by Cloudflare Pages from a branch, with the same
Node and pnpm versions, the same `--frozen-lockfile` install, and the same build
command as CI. A deployment that resolves dependencies differently from the test
run that approved it is not a tested deployment, regardless of what the
dashboard says.
