import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:5199';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE + '/swap', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
await page.screenshot({ path: 'C:/Users/pdark/AppData/Local/Temp/opencode/shot-swap-cards.png' });
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(1200);
await page.screenshot({ path: 'C:/Users/pdark/AppData/Local/Temp/opencode/shot-swap-cards2.png' });
await browser.close();
