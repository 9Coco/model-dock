import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrowserWindow, NativeImage } from 'electron';

type ProbeOptions = { hidden: boolean; theme: 'light' | 'dark' | 'system' };
interface ProbeEvent { event: string; elapsedMs: number; timestamp: string; nativeFocused: boolean; visible: boolean }
interface ColorReadback { background: string; color: string; opacity: string; filter: string; backdropFilter: string }
interface DomReadback {
  focused: boolean; visibility: string; theme?: string; colorScheme: string; prefersDark: boolean; readyState: string;
  width: number; height: number; devicePixelRatio: number; appMounted: boolean; modalCount: number;
  colors: Record<string, ColorReadback | null>; anchor: { x: number; y: number; expectedBackground: string } | null;
}
interface ProbeSample {
  stage: string; targetMs: number; elapsedMs: number; timestamp: string; mainPid: number;
  nativeFocused: boolean; contentsFocused: boolean; visible: boolean; minimized: boolean; enabled: boolean;
  backgroundThrottling: boolean; nativeBackground: string; dom: DomReadback;
  screenshot: string | null; pixels: { captured: boolean; width: number; height: number; meanSaturation: number; meanRgb: number[]; anchorRgb?: number[] };
}

/** Observes the normal presentation gate without changing focus until after the baseline. */
export function observeWindowPresentation(window: BrowserWindow, outputDir: string, options: ProbeOptions) {
  assert.equal(__MODELDOCK_SMOKE_BUILD__, true);
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const createdAt = Date.now(), events: ProbeEvent[] = [], samples: ProbeSample[] = [], images = new Map<string, NativeImage>();
  let origin = 0, paintReady = false, rendererReady = false, showRequests = 0;
  let focusRequestedByProduct: boolean | undefined, finished: Promise<void> | undefined;
  let begin!: () => void;
  const started = new Promise<void>(done => { begin = done; });
  const event = (name: string) => events.push({ event: name, elapsedMs: Date.now() - createdAt, timestamp: new Date().toISOString(), nativeFocused: window.isFocused(), visible: window.isVisible() });
  window.on('show', () => event('show')); window.on('hide', () => event('hide'));
  window.on('focus', () => event('focus')); window.on('blur', () => event('blur'));
  window.on('unresponsive', () => event('unresponsive')); window.on('responsive', () => event('responsive'));
  window.on('ready-to-show', () => { paintReady = true; event('ready-to-show'); });
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, Math.max(0, ms)));
  const snapshot = `(()=>{
    const colors={};for(const [name,selector] of [['root','html'],['body','body'],['app','.app-shell'],['main','.main-content'],['sidebar','.sidebar']]){const node=document.querySelector(selector);if(!node){colors[name]=null;continue;}const s=getComputedStyle(node);colors[name]={background:s.backgroundColor,color:s.color,opacity:s.opacity,filter:s.filter,backdropFilter:s.backdropFilter};}
    const main=document.querySelector('.main-content'),rect=main?.getBoundingClientRect();return {focused:document.hasFocus(),visibility:document.visibilityState,theme:document.documentElement.dataset.theme,colorScheme:getComputedStyle(document.documentElement).colorScheme,prefersDark:matchMedia('(prefers-color-scheme:dark)').matches,readyState:document.readyState,width:innerWidth,height:innerHeight,devicePixelRatio,appMounted:!!document.querySelector('.app-shell'),modalCount:document.querySelectorAll('.modal-backdrop').length,colors,anchor:rect?{x:rect.left+3,y:rect.top+3,expectedBackground:getComputedStyle(main).backgroundColor}:null};
  })()`;
  async function sample(stage: string, targetMs: number): Promise<void> {
    const native = { stage, targetMs, elapsedMs: Date.now() - origin, timestamp: new Date().toISOString(), mainPid: process.pid,
      nativeFocused: window.isFocused(), contentsFocused: window.webContents.isFocused(), visible: window.isVisible(), minimized: window.isMinimized(), enabled: window.isEnabled(), backgroundThrottling: window.webContents.getBackgroundThrottling(), nativeBackground: window.getBackgroundColor() };
    const dom = await window.webContents.executeJavaScript(snapshot) as DomReadback;
    if (options.hidden) {
      // Capturing an initially hidden Chromium surface can make the page
      // temporarily visible to its capturer. Keep this lifecycle assertion
      // observational: no renderer capture, native show, or focus is requested.
      samples.push({ ...native, dom, screenshot: null, pixels: { captured: false, width: 0, height: 0, meanRgb: [], meanSaturation: 0 } });
      writeFileSync(join(outputDir, 'window-presentation-progress.json'), JSON.stringify({ mainPid: process.pid, events, samples }, null, 2));
      return;
    }
    const picture = await window.webContents.capturePage(), size = picture.getSize(), bitmap = picture.toBitmap();
    assert.ok(!picture.isEmpty() && bitmap.length === size.width * size.height * 4, 'Presentation snapshots contain a complete renderer bitmap');
    const sum = [0, 0, 0]; let saturation = 0, count = 0;
    for (let index = 0; index < bitmap.length; index += 16) {
      const b = bitmap[index], g = bitmap[index + 1], r = bitmap[index + 2]; sum[0] += r; sum[1] += g; sum[2] += b;
      saturation += Math.max(r, g, b) - Math.min(r, g, b); count++;
    }
    let anchorRgb: number[] | undefined;
    if (dom.anchor) {
      const x = Math.min(size.width - 1, Math.max(0, Math.floor(dom.anchor.x * size.width / dom.width))), y = Math.min(size.height - 1, Math.max(0, Math.floor(dom.anchor.y * size.height / dom.height))), index = (y * size.width + x) * 4;
      anchorRgb = [bitmap[index + 2], bitmap[index + 1], bitmap[index]];
    }
    const screenshot = `window-presentation-${options.hidden ? 'hidden' : 'visible'}-${stage}.png`;
    writeFileSync(join(outputDir, screenshot), picture.toPNG()); images.set(stage, picture);
    samples.push({ ...native, dom, screenshot, pixels: { captured: true, ...size, meanRgb: sum.map(value => Number((value / count).toFixed(3))), meanSaturation: Number((saturation / count).toFixed(3)), ...(anchorRgb ? { anchorRgb } : {}) } });
    writeFileSync(join(outputDir, 'window-presentation-progress.json'), JSON.stringify({ mainPid: process.pid, events, samples }, null, 2));
  }
  function startTimeline(): void {
    if (origin) return;
    origin = Date.now(); begin();
    finished = (async () => {
      await Promise.all([0, 100, 800, 2000].map(async offset => { await pause(offset); await sample(`t${offset}`, offset); }));
      let comparison: Record<string, unknown> | undefined;
      if (!options.hidden) {
        // This is the only deliberate focus operation made by the probe. It
        // happens after every passive baseline snapshot has been collected.
        event('probe-focus-request'); window.focus();
        await pause(100); await sample('after-focus', Date.now() - origin);
        const before = images.get('t2000')!, after = images.get('after-focus')!, left = before.toBitmap(), right = after.toBitmap();
        let changed = 0, absolute = 0;
        if (left.length === right.length) for (let index = 0; index < left.length; index += 4) {
          let difference = 0; for (let channel = 0; channel < 3; channel++) difference += Math.abs(left[index + channel] - right[index + channel]);
          if (difference) changed++; absolute += difference;
        }
        const pre = samples.find(value => value.stage === 't2000')!, post = samples.find(value => value.stage === 'after-focus')!;
        comparison = { sameDimensions: left.length === right.length, changedPixelPercent: left.length === right.length ? Number((changed / (left.length / 4) * 100).toFixed(6)) : null,
          meanAbsoluteRgbDifference: left.length === right.length ? Number((absolute / (left.length / 4) / 3).toFixed(6)) : null,
          computedColorsUnchanged: JSON.stringify(pre.dom.colors) === JSON.stringify(post.dom.colors), themeUnchanged: pre.dom.theme === post.dom.theme,
          focusedBefore: pre.nativeFocused, focusedAfter: post.nativeFocused, documentFocusedBefore: pre.dom.focused, documentFocusedAfter: post.dom.focused };
      }
      const ordered = samples.sort((a, b) => a.elapsedMs - b.elapsedMs);
      assert.ok(paintReady && rendererReady, 'The real native-paint and renderer-ready gates were both observed');
      assert.ok(ordered.every(value => value.backgroundThrottling), 'This probe retains production background throttling');
      assert.ok(ordered.every(value => value.dom.appMounted && value.dom.modalCount === 0), 'Baseline content is the mounted app without a modal overlay');
      if (options.hidden) assert.ok(showRequests === 0 && ordered.every(value => !value.visible && !value.nativeFocused) && !events.some(value => value.event === 'show' || value.event === 'focus'), 'Hidden startup never shows or focuses the window');
      if (!options.hidden && process.env.MODELDOCK_SMOKE_WINDOW_EXPECT_ACTIVATION === '1') {
        assert.equal(showRequests, 1, 'Visible startup presents exactly once');
        assert.equal(focusRequestedByProduct, true, 'Visible startup explicitly requests native and page activation');
        assert.ok(ordered.every(value => value.visible), 'Every visible-startup sample stays visible');
      }
      writeFileSync(join(outputDir, 'window-presentation-validation.json'), JSON.stringify({ ok: true, mode: options.hidden ? 'hidden' : 'visible', expectedTheme: options.theme,
        mainPid: process.pid, platform: process.platform, displayBackend: process.argv.includes('--ozone-platform=x11') ? 'x11' : 'default', paintReady, rendererReady, showRequests, focusRequestedByProduct,
        noInputBeforeBaseline: true, nativeNoInputBeforeProbe: true, explicitProbeFocusCalls: options.hidden ? 0 : 1, captureScope: options.hidden ? 'No capture requested so the initially hidden page remains untouched' : 'Electron webContents.capturePage; excludes KDE compositor and native decorations', events, samples: ordered, comparison }, null, 2));
      const hold = Math.min(30_000, Math.max(0, Number(process.env.MODELDOCK_SMOKE_WINDOW_HOLD_MS) || 0));
      if (hold) await pause(hold);
    })();
    void finished.catch(() => {});
  }
  window.once('show', () => { if (!options.hidden) startTimeline(); });
  return {
    rendererPrepared(): void { rendererReady = true; event('renderer-ready'); if (options.hidden) startTimeline(); },
    beforePresent(focus: boolean): void { showRequests++; focusRequestedByProduct = focus; event('product-show-request'); },
    async complete(): Promise<void> {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([started, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Window presentation did not reach its expected startup gate')), 15_000); })]); }
      finally { clearTimeout(timeout); }
      await finished;
    },
  };
}
export type WindowPresentationProbe = ReturnType<typeof observeWindowPresentation>;
