# Independent settings pricing overflow evidence

Date: 2026-09-29. Source: [#1191](https://github.com/rynfar/meridian/pull/1191),
`34cca099bc8fdaf283631914fa1c1eaf6f1593c3`.
Base: `0ec52a28d9c70d0f9aa84767613c7a08125d25e4`.
Authored cherry-pick: `de0f00329ce0468e3b3bc274e197fbbd199fa407`.
Author and AuthorDate preserved: Nowaker `<spam@nowaker.net>`,
2026-09-27T21:24:28-05:00. No production-code maintainer correction needed.

## Independent browser result

Actual built `dist/server.js`, Node 22.22.3, macOS arm64. Fresh temporary
config/session/work directories, telemetry persistence and update checks disabled,
credentials read-only. No model requests. Pylon collaborative browser:
Chromium 152.0.7977.130 / Electron 44.4.2.

Preview resize timed out, so same-origin iframes provided exact CSS viewports
against the actual `/settings` route. This is desktop Chromium responsive-layout
verification, not an iOS/Android browser claim. All 25 pricing rows came from the
real settings API. Classic vertical scrollbars consume 15px of the viewport.

| Viewport | Page scrollWidth / clientWidth | Table / container | Inner horizontal scroll | Focusable rate input |
| --- | --- | --- | --- | --- |
| 375 | 360 / 360 | 581 / 270 | 311px | yes |
| 1280 | 1265 / 1265 | 810 / 810 | 0px | yes |

Negative control at 375: setting the wrapper's overflow to `visible` increases
page scrollWidth to **626px** while clientWidth stays **360px**. Restoring the
rule eliminates that overflow. This is a same-build rule-removal control, not a
separately built baseline. The full diff confirms the only production change is
the wrapper and its overflow/scrollbar CSS. Input markup and pricing behavior are
unchanged. Token use follows DESIGN.md; no body-background override was added.

Additional adversarial widths found **pre-existing unrelated overflow**:
320px has page/client 323/305 from feature rows; 768px has 761/753 from shared
header status. The pricing container itself stays within bounds at both widths.
These remain follow-up work; this PR does not make every settings viewport
perfect. A screenshot was visually inspected locally, but is not a durable
uploaded artifact. Deterministic measurements and the reproduction below are the
retained evidence. No animation or timing behavior needs a video.

## Repeatable browser probe

Build and start an isolated Meridian server, then open its `/settings` page.
Do not use a production instance for controls. Run this in the browser console
(or the collaborative browser evaluator); it throws if the important assertions
fail. The iframe is removed afterward.

```js
(async () => {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:375px;height:812px;border:0';
  frame.src = '/settings';
  document.body.append(frame);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('frame load timeout')), 10000);
      frame.onload = () => { clearTimeout(timer); resolve(); };
    });
    const d = frame.contentDocument;
    const deadline = Date.now() + 10000;
    while (!d.querySelector('#pricingRows input')) {
      if (Date.now() >= deadline) throw new Error('pricing rows timeout');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const assert = (ok, label) => { if (!ok) throw new Error(label); };
    const table = d.querySelector('.pricing-scroll');
    const results = [];
    for (const width of [375, 1280]) {
      frame.style.width = width + 'px';
      await new Promise(resolve => setTimeout(resolve, 100));
      assert(d.documentElement.scrollWidth === d.documentElement.clientWidth, 'page overflow');
      table.scrollLeft = table.scrollWidth;
      assert(width === 375 ? table.scrollLeft > 0 : table.scrollLeft === 0, 'table scroll');
      const input = table.querySelectorAll('input')[3];
      input.focus();
      assert(d.activeElement === input, 'input focus');
      results.push({ width, page: d.documentElement.scrollWidth,
        client: d.documentElement.clientWidth, table: table.scrollWidth,
        container: table.clientWidth, scrollLeft: table.scrollLeft });
    }
    frame.style.width = '375px';
    table.style.overflow = 'visible';
    await new Promise(resolve => setTimeout(resolve, 100));
    assert(d.documentElement.scrollWidth > d.documentElement.clientWidth, 'negative control');
    return results;
  } finally { frame.remove(); }
})()
```

## Local checks and limits

`npm run build` and standalone `npm run typecheck` passed using Bun 1.3.11.
Full `npm test` passed: 4,943 passed, 0 failed, 4 skipped across the main
and process-isolated stages. The retained browser probe above was also executed
verbatim and passed both positive cases and its negative control.
`npm ci` hit an unrelated bun2nix dependency install script that looks for
`bun.lock` in its package directory. `npm ci --ignore-scripts` succeeded; the
complete application build/test gates then ran. This is not evidence that a
normal clean npm install succeeds, and no lockfile change is bundled here.

Required final-head CI remains an acceptance gate. Source head must be rechecked
before any later source closure; no merge, release or source closure in this batch.
