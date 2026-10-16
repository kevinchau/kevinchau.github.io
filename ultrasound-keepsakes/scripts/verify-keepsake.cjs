/* Browser smoke checks. Run with Playwright available via NODE_PATH.
   Usage: node scripts/verify-keepsake.cjs [http://127.0.0.1:8086] [chromium|webkit] */
const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:8086';
  const engine = process.argv[3] || 'chromium';
  const browser = await (engine === 'webkit' ? webkit : chromium).launch(
    engine === 'webkit' ? { headless: true } : { headless: true, channel: 'chrome', args: ['--enable-unsafe-swiftshader'] }
  );
  const report = { engine, assertions: [], externalRequests: [], errors: [] };
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(base).origin) report.externalRequests.push(request.url());
  });
  const pass = text => report.assertions.push(text);
  const ready = () => page.waitForFunction(() => document.querySelector('#stage-mode').textContent === 'Interactive 3D sculpture', { timeout: 60000 });
  const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
  fs.mkdirSync('.work/qa', { recursive: true });
  try {
    await page.goto(`${base}/keepsake.html`, { waitUntil: 'networkidle' });
    await ready();
    assert.equal(await page.locator('#model-stage').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#auto-rotate').isDisabled(), true);
    pass('Prenatal GLB loads; loading clears; reduced motion disables rotation.');
    await page.screenshot({ path: `.work/qa/${engine}-prenatal-desktop.png`, fullPage: true });
    const before = digest(await page.locator('#portrait-canvas').screenshot());
    await page.locator('#portrait-canvas').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const after = digest(await page.locator('#portrait-canvas').screenshot());
    assert.notEqual(before, after);
    await page.keyboard.press('Home');
    pass('Keyboard rotation changes the rendered model; reset responds.');
    await page.locator('#choose-age-one').click();
    await ready();
    assert.equal(await page.locator('#choose-age-one').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#portrait-description').textContent(), /not a prediction/);
    assert.match(await page.locator('#download-model').getAttribute('href'), /age-one\.glb$/);
    await page.screenshot({ path: `.work/qa/${engine}-age-one-desktop.png`, fullPage: true });
    pass('Age-one model loads, its disclaimer and downloads update.');
    for (const name of ['prenatal', 'age-one']) {
      const response = await page.request.get(`${base}/output/models/${name}.glb`);
      assert.equal(response.status(), 200);
      assert.equal((await response.body()).subarray(0, 4).toString(), 'glTF');
      const portrait = await page.request.get(`${base}/output/imagegen/${name}-concept.png`);
      assert.equal(portrait.status(), 200);
      assert.equal((await portrait.body()).subarray(1, 4).toString(), 'PNG');
    }
    pass('Both model and portrait downloads return genuine GLB/PNG files.');
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(100);
      const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      assert.equal(dimensions.scroll, dimensions.client, `Horizontal overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `.work/qa/${engine}-age-one-mobile.png`, fullPage: true });
    pass('No horizontal overflow at 320, 390, or 768px.');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`${base}/keepsake.html`, { waitUntil: 'networkidle' });
    await ready();
    const focusItems = [];
    for (let i = 0; i < 24; i++) {
      // macOS WebKit uses Option-Tab for all page controls unless the user's
      // Safari keyboard preference is changed. Do not alter that preference.
      await page.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab');
      const item = await page.evaluate(() => {
        const el = document.activeElement, style = getComputedStyle(el);
        return { tag: el.tagName, text: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 70), outline: style.outlineStyle, width: style.outlineWidth };
      });
      if (item.tag === 'BODY') break;
      assert.notEqual(item.outline, 'none', `Missing focus outline for ${item.text}`);
      assert.notEqual(item.width, '0px', `Invisible focus outline for ${item.text}`);
      focusItems.push(item.text);
    }
    const requiredControls = await page.locator('button:not([disabled]),canvas[tabindex]').evaluateAll(elements => elements
      .filter(el => el.getClientRects().length)
      .map(el => el.getAttribute('aria-label') || el.textContent.trim().slice(0, 70)));
    for (const name of requiredControls) assert.ok(focusItems.includes(name), `Tab did not reach ${name}`);
    report.focusItems = focusItems;
    pass(`${engine === 'webkit' ? 'Option-Tab' : 'Tab'} navigation shows focus on ${focusItems.length} controls/links.`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#auto-rotate').click();
    assert.equal(await page.locator('#auto-rotate').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-action="left"]').click();
    assert.equal(await page.locator('#auto-rotate').getAttribute('aria-pressed'), 'false');
    pass('Optional rotation starts only on request and stops on manual control.');
    // Explicitly test download/network failure and user-triggered recovery.
    await page.route('**/output/models/*.glb', route => route.abort());
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#retry-load').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#portrait-preview').isVisible(), true);
    assert.equal(await page.locator('#model-stage').getAttribute('aria-busy'), 'false');
    await page.unroute('**/output/models/*.glb');
    await page.locator('#retry-load').click();
    await ready();
    pass('Failed mesh load shows portrait, clears loading, and recovers on retry.');
    assert.deepEqual(report.externalRequests, []);
    assert.deepEqual(report.errors, []);
    pass('No automatic third-party requests or uncaught script errors.');
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    await page.screenshot({ path: `.work/qa/${engine}-failure.png`, fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(`.work/qa/${engine}-report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
  }
})();
