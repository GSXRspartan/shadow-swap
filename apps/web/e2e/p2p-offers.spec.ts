/**
 * P2P offers in a REAL browser, production build, v0.48 reset network with NO SwapOffer
 * template recorded (the shipped state): the Swap page must say plainly that offers cannot
 * be created or filled, must not render any create/fill control, and an invitation pasted for
 * inspection must be labelled UNVERIFIED rather than presented as fact.
 */
import { test, expect } from '@playwright/test';
import { mockIndexer } from './mockIndexer.js';

function invitationCode(): string {
  const payload = {
    component: `component_${'c1'.repeat(32)}`,
    designatedTaker: null,
    expiresAtEpoch: '0',
    generation: 'v048',
    hashLock: null,
    maker: 'ab'.repeat(32),
    network: 'esmeralda',
    offered: { amount: '1000', kind: 'fungible', resource: `resource_${'a1'.repeat(32)}` },
    requested: { amount: '2500', kind: 'fungible', resource: `resource_${'a2'.repeat(32)}` },
    template: '12'.repeat(32),
    v: 1,
  };
  return `shadowswap-offer:v1:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

test('unpublished SwapOffer: the Swap page offers no P2P action and says why', async ({ page }) => {
  await mockIndexer(page);
  await page.goto('/swap');
  await expect(page.getByText('P2P offers are unavailable on this network')).toBeVisible();
  await expect(page.getByText(/No SwapOffer template is published and recorded/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Review and create offer|Review and fill/ })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Create offer' })).toHaveCount(0);
});

test('unpublished SwapOffer: a pasted invitation is shown only as UNVERIFIED claims, and junk is refused', async ({ page }) => {
  await mockIndexer(page);
  await page.goto('/swap');
  await page.getByText('Inspect an invitation (unverified)').click();
  const box = page.getByLabel('Invitation to inspect');
  await box.fill('definitely not an invitation');
  await expect(page.getByText('this is not a Shadow Swap offer invitation')).toBeVisible();
  await box.fill(invitationCode());
  await expect(page.getByText('UNVERIFIED: as written in the invitation')).toBeVisible();
  await expect(page.getByText(/nothing can be verified on-chain or filled/)).toBeVisible();
  const forged = `shadowswap-offer:v1:${Buffer.from(JSON.stringify({ v: 1, preimage: 'ab' })).toString('base64url')}`;
  await box.fill(forged);
  await expect(page.getByText(/never carry secrets/)).toBeVisible();
});
