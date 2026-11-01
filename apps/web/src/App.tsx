/**
 * Router.
 *
 * Only pages that actually function are registered. There is no mainnet route,
 * no hidden debug route, and no route that bypasses a gate.
 */

import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './state/AppContext.js';
import { AppShell } from './components/AppShell.js';
import { PoolsPage } from './pages/PoolsPage.js';
import { SwapRoutesPage } from './pages/SwapRoutesPage.js';
import { HomePage } from './pages/HomePage.js';
import { PoolPage } from './pages/PoolPage.js';
import { NftMarketplacePage } from './pages/NftMarketplacePage.js';
import { CollectionRoutePage } from './pages/NftMarketplacePage.js';
import { ActivityPage } from './pages/ActivityPage.js';
import { CrossLayerPage } from './pages/CrossLayerPage.js';
import { CrossLayerMarketPage } from './pages/CrossLayerMarketPage.js';
import { Card, EmptyState } from './components/primitives.js';

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_PATH ?? '/'}>
      <AppProvider>
        <AppShell>
          <Routes>
            {/* The landing page is the real `/`. `/pools` stays a first-class route
                so a bookmarked deep link keeps working after the redirect was
                introduced. */}
            <Route path="/" element={<HomePage />} />
            <Route path="/swap" element={<SwapRoutesPage />} />
            <Route path="/pools" element={<PoolsPage />} />
            <Route path="/pools/:poolComponent" element={<PoolPage />} />
            <Route path="/nfts" element={<NftMarketplacePage />} />
            <Route path="/nfts/:collectionResource" element={<CollectionRoutePage />} />
            <Route path="/cross-layer" element={<CrossLayerPage />} />
            <Route path="/market" element={<CrossLayerMarketPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppShell>
      </AppProvider>
    </BrowserRouter>
  );
}

function NotFound() {
  return (
    <Card>
      <EmptyState title="Page not found" detail="That address does not match any surface in this build." />
    </Card>
  );
}
