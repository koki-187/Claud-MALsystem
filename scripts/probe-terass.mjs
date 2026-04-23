// Probe what's actually on the TERASS PICKS page
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('terass') || p.url().includes('picks')) || ctx.pages()[0];
console.log('Current URL:', page.url());
console.log('Title:', await page.title());

const info = await page.evaluate(async () => {
  const idbList = ('databases' in indexedDB) ? await indexedDB.databases() : null;
  const lsKeys = Object.keys(localStorage);
  const ssKeys = Object.keys(sessionStorage);
  const cookieCount = document.cookie.split(';').filter(Boolean).length;
  const bodyText = document.body ? document.body.innerText.slice(0, 500) : '';
  const buttons = Array.from(document.querySelectorAll('button')).slice(0, 20).map(b => b.innerText.trim().slice(0, 50));
  const links = Array.from(document.querySelectorAll('a')).slice(0, 20).map(a => ({ text: a.innerText.trim().slice(0, 30), href: a.getAttribute('href')?.slice(0, 80) }));
  return { idbList, lsKeys, ssKeys, cookieCount, bodyText, buttons, links };
});
console.log('IndexedDB:', JSON.stringify(info.idbList));
console.log('localStorage keys (' + info.lsKeys.length + '):', info.lsKeys.slice(0, 30));
console.log('sessionStorage keys (' + info.ssKeys.length + '):', info.ssKeys.slice(0, 30));
console.log('Cookies count:', info.cookieCount);
console.log('Body text (first 500):', info.bodyText);
console.log('Buttons:', info.buttons);
console.log('Links (first 20):', info.links);
await browser.close().catch(() => {});
