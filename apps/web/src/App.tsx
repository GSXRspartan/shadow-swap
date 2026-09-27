/**
 * Router.
 *
 * Only pages that actually function are registered. There is no mainnet route,
 * no hidden debug route, and no route that bypasses a gate.
 */

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider } from './state/AppContext.js';
import { AppShell } from './components/AppShell.js';
import { PoolsPage } from './pages/PoolsPage.js';
import { PoolPage } from './pages/PoolPage.js';
import { NftMarketplacePage } from './pages/NftMarketplacePage.js';
import { CollectionRoutePage } from './pages/NftMarketplacePage.js';
import { ActivityPage } from './pages/ActivityPage.js';
import { Card, EmptyState } from './components/primitives.js';

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_PATH ?? '/'}>
      <AppProvider>
        <AppShell>
          <Routes>
            <Route path="/" element={<Navigate to="/pools" replace />} />
            <Route path="/pools" element={<PoolsPage />} />
            <Route path="/pools/:poolComponent" element={<PoolPage />} />
            <Route path="/nfts" element={<NftMarketplacePage />} />
            <Route path="/nfts/:collectionResource" element={<CollectionRoutePage />} />
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
