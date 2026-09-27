import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The complete set of build-time inputs the app is allowed to read. Anything not
 * listed here cannot influence the bundle, which keeps the mainnet / dev-provider
 * policy auditable in one place.
 */
function envBag(mode: string): Record<string, string | boolean | undefined> {
  return {
    MODE: mode,
    DEV: mode === 'development',
    VITE_TARI_NETWORK: process.env.VITE_TARI_NETWORK,
    VITE_INDEXER_URL: process.env.VITE_INDEXER_URL,
    VITE_ENABLE_DEV_PROVIDERS: process.env.VITE_ENABLE_DEV_PROVIDERS,
    VITE_WALLETD_URL: process.env.VITE_WALLETD_URL,
    VITE_USE_FIXTURE_DATA: process.env.VITE_USE_FIXTURE_DATA,
    TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT: process.env.TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT,
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    // No workspace source aliases.
    //
    // These packages are consumed through their declared `exports` contract,
    // which selects the ESM build for a browser bundle and the CommonJS build
    // for a Node `require`. An earlier revision aliased them to `src`, which
    // masked a broken package contract AND created a duplicate-module-instance
    // hazard: `multihop/proof.ts` brands terminal settlement proofs with a
    // module-private Symbol, so two copies of the package would mint and verify
    // against different brands. `test/instance-identity.test.cjs` asserts a
    // single instance in the built bundle.
    alias: [],
  },
  base: process.env.BASE_PATH || '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          charts: ['lightweight-charts'],
        },
      },
    },
  },
  server: {
    port: 3000,
  },
  define: {
    'process.env.BASE_PATH': JSON.stringify(process.env.BASE_PATH || '/'),
    __OOTLE_ENV__: JSON.stringify(envBag(mode)),
  },
}));
