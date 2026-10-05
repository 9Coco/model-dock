import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { nativeImage, type BrowserWindow } from 'electron';
import type { AuthAccount } from '../shared/auth-types';
import type { Store } from './store';

interface SurfaceReadback { selector: string; color: string; rgb: number[]; }
interface CompactLayout {
  viewport: { width: number; height: number };
  horizontalOverflow: boolean;
  groups: { kind: string; top: number; bottom: number; height: number; rows: number }[];
  rowFonts: number[];
  progressBars: number;
  remainingPercents: string[];
  surfaces: SurfaceReadback[];
  accent: SurfaceReadback;
}
interface MaterialReadback {
  icons: { symbol: string; family: string; width: number; height: number; paths: number; geometryWidth: number; geometryHeight: number; color: string; fill: string; stroke: string; currentColor: boolean; decorative: boolean; focusable: boolean; externalNode: boolean; controlNamed: boolean; filled?: number; outline?: number }[];
  navigation: { page: string; symbol: string; active: boolean; filled?: number; outline?: number }[];
  brand: { app: string; tools: { tool: string; mask: string; material: boolean }[] };
  remoteFonts: string[];
  legacySvg: number;
}
interface AvatarReadback {
  id: string; kind: string; state: string; width: number; height: number; radius: string; overflow: string;
  fallback: string; naturalWidth: number; naturalHeight: number; referrerPolicy: string; source: string;
  authenticated: boolean; imageContains: boolean;
}

/** Real Electron renderer/preload, isolated encrypted store, synthetic servers. */
export async function verifyCompactUi(window: BrowserWindow, store: Store, outputDir: string, captureUi: () => Promise<Buffer>): Promise<void> {
  assert.equal(process.env.MODELDOCK_SMOKE_AUTH_MOCK, '1');
  assert.equal(resolve(outputDir), resolve(process.env.MODELDOCK_SMOKE!));
  const child = relative(resolve(outputDir, 'data'), resolve(store.dataDir));
  assert.ok(child && !child.startsWith('..') && !/^[A-Za-z]:/.test(child), 'Compact verification requires an isolated profile inside its output directory');
  const avatarUrl = 'https://avatars.githubusercontent.com/u/424242?v=4', brokenAvatarUrl = 'https://avatars.githubusercontent.com/u/424244?v=4';
  const pixels = Buffer.alloc(48 * 48 * 4);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
    const at = (y * 48 + x) * 4, mark = x > 10 && x < 37 && y > 10 && y < 37;
    pixels[at] = mark ? 240 : 40; pixels[at + 1] = mark ? 245 : 125; pixels[at + 2] = mark ? 255 : 190; pixels[at + 3] = 255;
  }
  const avatarPng = nativeImage.createFromBitmap(pixels, { width: 48, height: 48 }).toPNG();
  const avatarRequests: { url: string; status: number; referrer: string; authorization: boolean; cookie: boolean }[] = [];
  // The handler is scoped to this already-verified smoke session and never
  // reaches an arbitrary remote URL or provides a production image proxy.
  window.webContents.session.protocol.handle('https', request => {
    const status = request.url === avatarUrl ? 200 : 404;
    avatarRequests.push({ url: request.url, status, referrer: request.headers.get('referer') ?? '', authorization: request.headers.has('authorization'), cookie: request.headers.has('cookie') });
    return new Response(status === 200 ? new Uint8Array(avatarPng).buffer : null, { status, headers: { 'content-type': 'image/png', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
  });
  const originalAvatarFixture = process.env.MODELDOCK_SMOKE_AVATAR_FIXTURE;
  process.env.MODELDOCK_SMOKE_AVATAR_FIXTURE = '1';
  try {
  const evaluate = async <T>(code: string): Promise<T> => {
    const result = await window.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await(${code})}}catch(error){return {ok:false,message:error instanceof Error?error.message:'UI script failed'}}})()`);
    if (!result.ok) throw new Error(`Compact UI: ${result.message}; expression: ${code.slice(0, 160)}`);
    return result.value as T;
  };
  const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  async function waitFor(code: string, label: string) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) { if (await evaluate<boolean>(code)) return; await pause(35); }
    writeFileSync(join(outputDir, 'electron-compact-ui-timeout.png'), await captureUi());
    writeFileSync(join(outputDir, 'compact-ui-timeout.json'), JSON.stringify(await evaluate('({text:document.body.innerText.slice(-4500),viewport:{width:innerWidth,height:innerHeight}})'), null, 2));
    throw new Error(`Compact UI verification timed out: ${label}`);
  }
  async function click(selector: string) {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  const dismissToasts = () => evaluate(`document.querySelectorAll('.toast-stack [aria-label="关闭提示"]').forEach(button=>button.click())`);
  const accounts = () => evaluate<AuthAccount[]>('window.modelDock.authAccounts()');
  const signature = () => createHash('sha256').update(JSON.stringify({ providers: store.listProviders(), models: store.listModels(), secrets: store.listProviders().map(provider => [provider.id, store.getSecret(provider.id)]) })).digest('hex');
  const neutral = (surface: SurfaceReadback) => {
    assert.equal(surface.rgb.length, 3, `Surface color must be measurable: ${surface.selector}`);
    assert.ok(Math.max(...surface.rgb) - Math.min(...surface.rgb) <= 14, `Dark surface must be neutral black/gray: ${surface.selector} ${surface.color}`);
    assert.ok(Math.max(...surface.rgb) <= 82, `Dark surface must remain dark: ${surface.selector} ${surface.color}`);
  };
  const blue = (surface: SurfaceReadback) => {
    assert.equal(surface.rgb.length, 3, 'Accent must be measurable');
    assert.ok(surface.rgb[2] > surface.rgb[0] + 20 && surface.rgb[2] >= surface.rgb[1], `Accent must be blue: ${surface.color}`);
  };
  const materialScript = `(()=>{
    const visible=element=>{const box=element.getBoundingClientRect(),css=getComputedStyle(element);return box.width>0&&box.height>0&&box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth&&css.display!=='none'&&css.visibility==='visible';};
    const variant=icon=>{const filled=icon.querySelector('.material-icon-filled'),outline=icon.querySelector('.material-icon-outline');return {filled:filled?Number(getComputedStyle(filled).opacity):undefined,outline:outline?Number(getComputedStyle(outline).opacity):undefined};};
    const icons=[...document.querySelectorAll('svg[data-material-symbol]')].filter(visible).map(icon=>{
      const box=icon.getBoundingClientRect(),geometry=icon.getBBox(),css=getComputedStyle(icon),control=icon.closest('button,[role=button]');
      const named=!control||!!(control.getAttribute('aria-label')||control.getAttribute('title')||control.textContent.trim());
      return {symbol:icon.dataset.materialSymbol,family:icon.dataset.iconFamily,width:box.width,height:box.height,paths:icon.querySelectorAll('path[d]').length,geometryWidth:geometry.width,geometryHeight:geometry.height,
        color:css.color,fill:css.fill,stroke:css.stroke,currentColor:icon.getAttribute('fill')==='currentColor'&&[...icon.querySelectorAll('path')].every(path=>getComputedStyle(path).fill===css.color),
        decorative:icon.getAttribute('aria-hidden')==='true',focusable:icon.getAttribute('focusable')!=='false'||icon.getAttribute('tabindex')==='0',externalNode:!!icon.querySelector('use,image,foreignObject'),controlNamed:named,...variant(icon)};
    });
    const navigation=[...document.querySelectorAll('.sidebar button[data-page]')].flatMap(button=>{const icon=button.querySelector('svg[data-material-symbol]');return icon?[{page:button.dataset.page,symbol:icon.dataset.materialSymbol,active:button.getAttribute('aria-current')==='page',...variant(icon)}]:[];});
    const brand={app:document.querySelector('[data-app-brand-icon]')?.getAttribute('src')||'',tools:[...document.querySelectorAll('.sidebar [data-tool-icon]')].map(icon=>{const mark=icon.querySelector('.tool-logo-mark'),css=mark?getComputedStyle(mark):null;return {tool:icon.dataset.toolIcon,mask:css?.maskImage||css?.webkitMaskImage||'',material:!!icon.querySelector('[data-material-symbol]')};})};
    const remoteFonts=performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>/https?:\\/\\/(?:fonts\\.googleapis\\.com|fonts\\.gstatic\\.com)\\//i.test(name));
    return {icons,navigation,brand,remoteFonts,legacySvg:document.querySelectorAll('svg.lucide').length};
  })()`;
  const materialLayouts: Array<{ name: string; value: MaterialReadback }> = [];
  const avatarLayouts: Array<{ name: string; value: AvatarReadback[] }> = [];
  async function inspectAvatars(name: string) {
    const read = () => evaluate<AvatarReadback[]>(`[...document.querySelectorAll('[data-account-avatar]')].map(avatar=>{
      const box=avatar.getBoundingClientRect(),css=getComputedStyle(avatar),image=avatar.querySelector('img[data-avatar-image]'),row=avatar.closest('[data-auth-account]'),kind=avatar.closest('[data-auth-kind]')?.dataset.authKind;
      return {id:avatar.dataset.accountAvatar,kind,state:avatar.dataset.avatarState,width:box.width,height:box.height,radius:css.borderRadius,overflow:css.overflow,
        fallback:avatar.querySelector('[data-avatar-fallback]')?.textContent.trim()||'',naturalWidth:image?.naturalWidth||0,naturalHeight:image?.naturalHeight||0,
        referrerPolicy:image?.referrerPolicy||'',source:image?.getAttribute('src')||'',authenticated:row?.querySelector('.auth-identity-dot')?.classList.contains('ready')||false,imageContains:!!image};
    })`);
    let value = await read();
    if (!value.length) return;
    const settled = (avatars: AvatarReadback[]) => avatars.length === 3 && avatars.every(avatar => avatar.kind === 'copilot'
      ? avatar.state === 'image' && avatar.naturalWidth > 0 && avatar.naturalHeight > 0
      : avatar.state === 'fallback' && !avatar.imageContains);
    // Navigating through Settings remounts AccountAvatar. Its initial letter
    // while an image is loading is legitimate, so await onLoad/onError on every
    // inspection rather than treating the initial state as a settled failure.
    const deadline = Date.now() + 12_000;
    while (!settled(value) && Date.now() < deadline) { await pause(40); value = await read(); }
    if (!settled(value)) {
      writeFileSync(join(outputDir, 'avatar-settle-timeout.json'), JSON.stringify({ name, avatars: value, imageRequests: avatarRequests,
        policy: await evaluate('document.querySelector("meta[http-equiv=Content-Security-Policy]")?.content') }, null, 2));
      writeFileSync(join(outputDir, `electron-avatar-settle-timeout-${name}.png`), await captureUi());
      assert.fail(`Avatar decode/error did not settle after navigation: ${name}`);
    }
    assert.equal(value.length, 3, 'One personal avatar belongs to each authorized account row');
    for (const avatar of value) {
      assert.ok(Math.abs(avatar.width - 32) < 1 && Math.abs(avatar.height - 32) < 1, `Account avatar retains 32px dimensions: ${avatar.kind}`);
      assert.ok(avatar.radius.includes('50%') || parseFloat(avatar.radius) >= 16, `Avatar must be circular: ${avatar.radius}`);
      assert.equal(avatar.authenticated, true, 'Avatar state must not replace the separate authorization indicator');
      if (avatar.kind === 'copilot') {
        assert.equal(avatar.state, 'image'); assert.ok(avatar.naturalWidth > 0 && avatar.naturalHeight > 0, 'Official-profile avatar must actually decode');
        assert.equal(avatar.source, avatarUrl); assert.equal(avatar.referrerPolicy, 'no-referrer');
      } else {
        assert.equal(avatar.state, 'fallback'); assert.ok(/^[CX]$/u.test(avatar.fallback), `No-image or failed-image account must retain its initial: ${avatar.kind} ${avatar.fallback}`);
        assert.equal(avatar.naturalWidth, 0); assert.equal(avatar.imageContains, false, 'Fallback must remove an unusable image element');
      }
    }
    avatarLayouts.push({ name, value });
  }
  let originalBrand: MaterialReadback['brand'] | undefined;
  async function inspectMaterial(name: string) {
    const value = await evaluate<MaterialReadback>(materialScript);
    assert.ok(value.icons.length >= 12, `Functional Material icons must render: ${name}`);
    assert.equal(value.legacySvg, 0, 'Functional controls must use the selected Material family');
    assert.deepEqual(value.remoteFonts, [], 'Material SVG icons must not load Google icon fonts at runtime');
    const expected: Record<string, string> = { providers: 'hub', mcp: 'dns', skills: 'menu_book', auth: 'key', usage: 'monitoring', models: 'stacks', service: 'monitor_heart', settings: 'tune' };
    assert.deepEqual(value.navigation.map(item => item.page).sort(), Object.keys(expected).sort(), 'Eight functional sidebar destinations must retain their semantic icons');
    for (const item of value.navigation) {
      assert.equal(item.symbol, expected[item.page], `Correct navigation icon: ${item.page}`);
      assert.equal(item.filled, item.active ? 1 : 0, `Selected navigation uses Google's fill 1 geometry: ${item.page}`);
      assert.equal(item.outline, item.active ? 0 : 1, `Unselected navigation uses outline geometry: ${item.page}`);
    }
    for (const icon of value.icons) {
      assert.equal(icon.family, 'material-symbols-rounded');
      assert.ok(icon.width >= 11 && icon.width <= 40 && icon.height >= 11 && icon.height <= 40 && Math.abs(icon.width - icon.height) < 1, `Icon must retain a suitable square control size: ${icon.symbol} ${icon.width}x${icon.height}`);
      assert.ok(icon.paths > 0 && icon.geometryWidth > 0 && icon.geometryHeight > 0, `Local SVG path must be drawable: ${icon.symbol}`);
      assert.ok(icon.currentColor && icon.fill === icon.color && icon.stroke === 'none', `Filled paths inherit currentColor without a Lucide stroke: ${icon.symbol}`);
      assert.ok(icon.decorative && !icon.focusable && !icon.externalNode, `Inline decorative icon must not add a focus stop or remote reference: ${icon.symbol}`);
      assert.ok(icon.controlNamed, `An icon control must retain its text, title or ARIA name: ${icon.symbol}`);
    }
    assert.deepEqual(value.brand.tools.map(item => item.tool), ['codex', 'opencode', 'dsh', 'vscode', 'copilot']);
    assert.ok(value.brand.app && value.brand.tools.every(item => item.mask.startsWith('url(') && !item.material), 'App and tool identities remain separate local brand assets');
    if (!originalBrand) originalBrand = value.brand;
    else assert.deepEqual(value.brand, originalBrand, 'Functional icon replacement must preserve brand resource identities');
    materialLayouts.push({ name, value });
    return value;
  }
  const surfaceScript = `(()=>{
    const rgb=color=>(color.match(/[\\d.]+/g)||[]).slice(0,3).map(Number);
    const surface=(element,selector)=>{
      let target=element,color='rgba(0, 0, 0, 0)';
      while(target){color=getComputedStyle(target).backgroundColor;if(!/rgba\\([^)]*,\\s*0\\)$/.test(color)&&color!=='transparent')break;target=target.parentElement;}
      return {selector,color,rgb:rgb(color)};
    };
    const selectors=['.sidebar','.sidebar-bottom','.topbar','.main-shell','.account-group','.account-group-header','.account-row','[data-auth-account-menu]','.quota-credit-list[open] > ul','.settings-panel .panel','.settings-panel input','.settings-panel select','.tool-detail-summary','.usage-metrics > div','.usage-chart','.modal','.modal-header','.modal-footer','.modal input'];
    const surfaces=selectors.flatMap(selector=>{const element=document.querySelector(selector);return element?[surface(element,selector)]:[];});
    const root=getComputedStyle(document.documentElement),probe=document.createElement('span');probe.style.color=root.getPropertyValue('--accent');document.body.append(probe);
    const accent={selector:'--accent',color:getComputedStyle(probe).color,rgb:rgb(getComputedStyle(probe).color)};probe.remove();
    return {surfaces,accent};
  })()`;
  async function capture(name: string, strictDark = false) {
    await dismissToasts(); await pause(120);
    const colors = await evaluate<{ surfaces: SurfaceReadback[]; accent: SurfaceReadback }>(surfaceScript);
    if (strictDark) { colors.surfaces.forEach(neutral); blue(colors.accent); }
    const primaryButtons = strictDark ? await evaluate<SurfaceReadback[]>(`(()=>[...document.querySelectorAll('button.primary')].filter(button=>{const box=button.getBoundingClientRect();return box.width>0&&box.height>0&&box.bottom>0&&box.top<innerHeight;}).map(button=>{const color=getComputedStyle(button).backgroundColor;return {selector:'button.primary '+button.textContent.trim(),color,rgb:(color.match(/[\\d.]+/g)||[]).slice(0,3).map(Number)};}))()`) : [];
    primaryButtons.forEach(blue);
    assert.equal(await evaluate<boolean>('document.documentElement.scrollWidth>innerWidth+1'), false, `No horizontal overflow: ${name}`);
    await inspectMaterial(name);
    await inspectAvatars(name);
    writeFileSync(join(outputDir, `electron-compact-${name}.png`), await captureUi());
    return { name, ...colors, primaryButtons };
  }

  // The empty view and fixture accounts are written only to this smoke profile.
  for (const provider of store.listProviders().filter(provider => provider.kind === 'codex' || provider.kind === 'grok')) store.deleteProvider(provider.id);
  for (const account of await accounts()) if (account.kind === 'copilot') await evaluate(`window.modelDock.copilotLogoutAccount(${JSON.stringify(account.providerId)})`);
  await click('[data-page="settings"]'); await click('[data-theme-choice="dark"]'); await click('[data-page="auth"]');
  await waitFor('document.querySelectorAll("[data-auth-kind]").length===3&&document.querySelectorAll("[data-auth-account]").length===0', 'three empty compact account groups');
  window.setSize(1320, 880);
  const pageColors: unknown[] = [await capture('auth-empty-dark-1320', true)];
  const fixtureIds: string[] = [];
  for (const [kind, email] of [['codex', 'codex.compact.preview.long.name@example.test'], ['grok', 'xai.compact.preview@example.test']] as const) {
    const provider = store.saveProvider({ name: kind === 'codex' ? 'ChatGPT 预览账号' : 'xAI 预览账号', kind,
      baseUrl: kind === 'codex' ? 'https://chatgpt.com/backend-api/codex' : 'https://cli-chat-proxy.grok.com/v1', enabled: true });
    const access = `COMPACT_PRIVATE_ACCESS.${Buffer.from(JSON.stringify({ sub: `compact-${kind}`, email, exp: Math.floor(Date.now() / 1000) + 7200,
      ...(kind === 'codex' ? { picture: brokenAvatarUrl } : {}),
      'https://api.openai.com/auth': { chatgpt_account_id: `compact-workspace-${kind}`, chatgpt_plan_type: kind === 'codex' ? 'plus' : undefined } })).toString('base64url')}.mock`;
    store.setSecret(provider.id, { accessToken: access, accountId: `compact-workspace-${kind}`, expiresAt: Date.now() + 7200_000 });
    fixtureIds.push(provider.id);
  }
  await click('[data-action="reload-auth-accounts"]');
  await waitFor(`(async()=>{const accounts=await window.modelDock.authAccounts();return ${JSON.stringify(fixtureIds)}.every(id=>accounts.find(account=>account.providerId===id)?.usage.status==='ready')})()`, 'synthetic OAuth quota auto-query');
  await click('[data-action="copilot-login"]');
  const copilotSelector = '[data-auth-account="copilot:424242"]';
  await waitFor(`(async()=>{const accounts=await window.modelDock.authAccounts();return accounts.find(account=>account.kind==='copilot')?.usage.status==='ready'&&!!document.querySelector(${JSON.stringify(copilotSelector)})})()`, 'synthetic Copilot device login and quota');
  if (await evaluate<boolean>('!!document.querySelector("[role=dialog]")')) await click('[aria-label="关闭对话框"]');
  await waitFor('document.querySelectorAll("[data-auth-account] progress").length===4', 'four preserved quota windows');
  await waitFor(`document.querySelector('[data-auth-kind="copilot"] [data-account-avatar]')?.dataset.avatarState==='image'&&document.querySelector('[data-auth-kind="copilot"] img[data-avatar-image]')?.naturalWidth>0&&document.querySelector('[data-auth-kind="codex"] [data-account-avatar]')?.dataset.avatarState==='fallback'`, 'decoded GitHub avatar and failed-image fallback');
  await waitFor(`!document.querySelector('[data-auth-kind="codex"] img[data-avatar-image]')`, 'broken avatar settled on its initial');
  const brokenReadCount = avatarRequests.filter(request => request.url === brokenAvatarUrl).length;
  assert.ok(brokenReadCount > 0); await pause(5300);
  assert.equal(avatarRequests.filter(request => request.url === brokenAvatarUrl).length, brokenReadCount, 'Five-second account-cache polling must not retry a failed avatar URL');
  const measured = await accounts(), codex = measured.find(account => account.kind === 'codex')!;
  assert.equal(measured.length, 3); assert.deepEqual(codex.usage.windows.map(value => value.remainingPercent), [58, 64]);
  assert.equal(codex.usage.resetCredits?.available, 2); assert.equal(codex.usage.resetCredits?.expiresAt.length, 2);
  assert.equal(measured.find(account => account.kind === 'grok')?.usage.windows[0].remainingPercent, 78);
  assert.equal(measured.find(account => account.kind === 'copilot')?.usage.windows[0].remainingPercent, 82);
  assert.doesNotMatch(JSON.stringify(measured), /COMPACT_PRIVATE_ACCESS|SYNTHETIC_COPILOT_QUOTA_TOKEN|accessToken|refreshToken/);
  assert.equal(readFileSync(join(store.dataDir, 'modeldock.sqlite')).includes(Buffer.from('COMPACT_PRIVATE_ACCESS')), false);

  const layouts: Array<{ theme: string; width: number; layout: CompactLayout }> = [];
  for (const theme of ['dark', 'light']) {
    await click('[data-page="settings"]'); await click(`[data-theme-choice="${theme}"]`); await click('[data-page="auth"]');
    for (const [width, height] of [[1320, 880], [980, 680]]) {
      window.setSize(width, height); await pause(140); await dismissToasts();
      const layout = await evaluate<CompactLayout>(`(()=>{
        const colors=${surfaceScript};
        return {viewport:{width:innerWidth,height:innerHeight},horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,
          groups:[...document.querySelectorAll('[data-auth-kind]')].map(group=>{const box=group.getBoundingClientRect();return {kind:group.dataset.authKind,top:box.top,bottom:box.bottom,height:box.height,rows:group.querySelectorAll('[data-auth-account]').length};}),
          rowFonts:[...document.querySelectorAll('[data-auth-account] strong,[data-auth-account] small,[data-auth-account] span')].filter(element=>element.getBoundingClientRect().height>0).map(element=>parseFloat(getComputedStyle(element).fontSize)),
          progressBars:document.querySelectorAll('[data-auth-account] progress').length,
          remainingPercents:[...document.querySelectorAll('[data-auth-account] [data-remaining-percent]')].map(element=>element.dataset.remainingPercent),...colors};
      })()`);
      assert.equal(layout.horizontalOverflow, false); assert.equal(layout.groups.length, 3); assert.equal(layout.progressBars, 4);
      assert.deepEqual([...layout.remainingPercents].sort(), ['58', '64', '78', '82']);
      for (const group of layout.groups) {
        assert.equal(group.rows, 1); assert.ok(group.height <= (group.kind === 'codex' ? 185 : 155), `Account group must remain compact: ${group.kind} ${group.height}px`);
        assert.ok(group.top >= 0 && group.bottom <= layout.viewport.height + 1, `All three account groups must fit: ${group.kind} bottom=${group.bottom} viewport=${layout.viewport.height}`);
      }
      assert.ok(layout.rowFonts.every(value => value >= 12), 'Compact rows must preserve a readable minimum 12px font');
      if (theme === 'dark') { layout.surfaces.forEach(neutral); blue(layout.accent); }
      await inspectMaterial(`auth-${theme}-${width}`);
      await inspectAvatars(`auth-${theme}-${width}`);
      layouts.push({ theme, width, layout }); writeFileSync(join(outputDir, `electron-compact-auth-${theme}-${width}.png`), await captureUi());
    }
  }

  // Open and cancel destructive confirmations, never confirm an account write.
  await click('[data-page="settings"]'); await click('[data-theme-choice="dark"]'); await click('[data-page="auth"]');
  const beforeCancel = signature(), menu = `[data-action="account-menu"][data-account-id="${codex.providerId}"]`;
  const menuReadback: unknown[] = [];
  for (const action of ['account-logout', 'account-delete']) {
    await click(menu); await waitFor('!!document.querySelector("[role=menu]")', 'account actions menu');
    assert.equal(await evaluate<boolean>('!!document.querySelector("[role=menu] [data-action=account-reauth]")&&!document.querySelector("[role=menu] [data-action=account-reauth]").disabled'), true, 'Reauthorization remains reachable');
    if (action === 'account-logout') pageColors.push(await capture('account-menu-dark-980', true));
    await click(`[role="menu"] [data-action="${action}"]`); await waitFor('!!document.querySelector("[role=dialog]")', `${action} confirmation`);
    pageColors.push(await capture(`${action}-dialog-dark-980`, true));
    await evaluate(`(()=>{const cancel=[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent.trim()==='取消');if(!cancel)throw new Error('Cancel button missing');cancel.click();})()`);
    await waitFor('!document.querySelector("[role=dialog]")', `${action} canceled`);
    assert.equal(signature(), beforeCancel, 'Canceling an account confirmation must preserve providers, models and credentials');
    menuReadback.push({ action, canceled: true, accountStatePreserved: true });
  }
  await click(menu); await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await waitFor('!document.querySelector("[role=menu]")', 'Escape closes account actions');
  const expiry = `[data-auth-account="${codex.providerId}"] [data-reset-expiries]`;
  await click(`${expiry} summary`); await waitFor(`document.querySelector(${JSON.stringify(expiry)}).open`, 'reset expiration popup');
  const expiryLayout = await evaluate<{ count: number; visible: boolean; groupHeight: number }>(`(()=>{const details=document.querySelector(${JSON.stringify(expiry)}),list=details.querySelector('ul'),box=list.getBoundingClientRect();return {count:list.querySelectorAll('li').length,visible:box.top>=0&&box.bottom<=innerHeight+1&&box.left>=0&&box.right<=innerWidth+1,groupHeight:details.closest('[data-auth-kind]').getBoundingClientRect().height};})()`);
  assert.equal(expiryLayout.count, 2); assert.equal(expiryLayout.visible, true); assert.ok(expiryLayout.groupHeight <= 185, 'Opening reset details must not expand the compact group');
  pageColors.push(await capture('auth-reset-expiries-dark-980', true)); await click(`${expiry} summary`);
  const refresh = `[data-action="refresh-account-quota"][data-account-id="${codex.providerId}"]`;
  const busy = await evaluate<{ disabled: boolean; accessible: boolean }>(`(async()=>{const button=document.querySelector(${JSON.stringify(refresh)});button.click();await new Promise(resolve=>requestAnimationFrame(resolve));return {disabled:button.disabled,accessible:!!button.getAttribute('aria-label')};})()`);
  assert.equal(busy.disabled, true); assert.equal(busy.accessible, true);
  await waitFor(`!document.querySelector(${JSON.stringify(refresh)}).disabled`, 'quota refresh completed');

  const add = '[data-auth-add-account="codex"]';
  await click(add); await waitFor('!!document.querySelector("[role=dialog] input")', 'add-account modal input');
  pageColors.push(await capture('account-add-dialog-dark-980', true));
  await click('[aria-label="关闭对话框"]'); assert.equal(signature(), beforeCancel, 'Closing account draft must not create an account');
  for (const page of ['settings', 'usage']) {
    await click(`[data-page="${page}"]`); await waitFor(`!!document.querySelector(${JSON.stringify(page === 'settings' ? '.settings-panel .panel' : '.usage-panel')})`, page);
    pageColors.push(await capture(`${page}-dark-980`, true));
  }
  await click('.sidebar [data-page="tools"][data-tool-id="codex"]'); await waitFor('!!document.querySelector("[data-tool-binding=codex]")', 'tool configuration');
  pageColors.push(await capture('tool-codex-dark-980', true));
  await click('[data-page="auth"]'); window.setSize(1320, 880); await pause(140);
  pageColors.push(await capture('auth-final-dark-1320', true));
  // SVG geometry must remain available when browser network loading is disabled.
  // Only this isolated Electron session is affected; main-process quota mocks
  // and the real user's app/credentials are outside this read-only check.
  const offlinePages = ['providers', 'mcp', 'skills', 'usage', 'models', 'service', 'settings', 'tools'];
  window.webContents.session.enableNetworkEmulation({ offline: true });
  try {
    window.setSize(980, 680);
    for (const page of offlinePages) {
      const selector = page === 'tools' ? '.sidebar [data-page="tools"][data-tool-id="codex"]' : `.sidebar [data-page="${page}"]`;
      await click(selector); await waitFor(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-current')==='page'`, `offline Material page ${page}`);
      pageColors.push(await capture(`material-${page}-offline-dark-980`, true));
    }
  } finally { window.webContents.session.disableNetworkEmulation(); }
  await click('[data-page="auth"]'); window.setSize(1320, 880); await pause(140);
  assert.doesNotMatch(await evaluate<string>('document.body.innerText'), /COMPACT_PRIVATE_ACCESS|SYNTHETIC_COPILOT_QUOTA_TOKEN|accessToken|refreshToken/);
  writeFileSync(join(outputDir, 'compact-ui-validation.json'), JSON.stringify({ ok: true, platform: process.platform, accountKinds: ['copilot', 'codex', 'grok'], compactGroupsFitViewport: true,
    measuredRemainingPercents: [82, 58, 64, 78], progressBars: 4, resetCredits: 2, resetExpirations: expiryLayout.count, expiryPopupDoesNotExpandGroup: true,
    readableMinimumFontPx: 12, neutralDarkSurfaces: true, blueAccents: true, busyRefreshDisabledAndNamed: true, reauthorizationReachable: true, reauthorizationExecuted: false,
    accountConfirmationsCanceled: menuReadback, cancelPreservesAccountCredentials: true, sourceTokensNotInRenderer: true, encryptedSyntheticCredentials: true,
    layouts, pageColors, realClientProfilesChanged: false, realAccountsQueried: false, liveProviderInferenceTested: false }, null, 2));
  writeFileSync(join(outputDir, 'material-icons-validation.json'), JSON.stringify({ ok: true, family: 'material-symbols-rounded', localInlineSvg: true, currentColor: true, semanticFunctionalNavigation: true,
    filledActiveNavigation: true, accessibleIconControls: true, brandIdentitiesPreserved: true, runtimeGoogleIconFontsLoaded: false, offlineBrowserSessionVerified: true,
    offlinePages, layouts: materialLayouts, realClientProfilesChanged: false, realAccountsQueried: false }, null, 2));
  assert.ok(avatarRequests.some(request => request.url === avatarUrl && request.status === 200), 'Avatar fixture must deliver a successful PNG');
  assert.ok(avatarRequests.some(request => request.url === brokenAvatarUrl && request.status === 404), 'Broken-avatar fallback must be exercised by an actual image request');
  assert.ok(avatarRequests.every(request => [avatarUrl, brokenAvatarUrl].includes(request.url) && !request.referrer && !request.authorization && !request.cookie), 'Personal avatars must not leak a referrer, credential or cookie');
  const policy = await evaluate<string>('document.querySelector("meta[http-equiv=Content-Security-Policy]").content');
  assert.match(policy, /img-src[^;]*https:\/\/avatars\.githubusercontent\.com/);
  assert.doesNotMatch(policy, /img-src[^;]*(?:https:\s|\*)/);
  writeFileSync(join(outputDir, 'account-avatar-validation.json'), JSON.stringify({ ok: true, syntheticPngDecoded: true, sourceClaimsWithoutAvatarUseInitial: true, imageHttp404UsesInitial: true,
    avatarSizePx: 32, circular: true, separateAuthIndicatorPreserved: true, cspUsesExplicitAvatarHosts: true, noReferrer: true, noCredentialsInImageRequests: true, failedImageNotRetriedByCachePolling: true,
    layouts: avatarLayouts, imageRequests: avatarRequests, realProfilePicturesRequested: false, realAccountsQueried: false, realClientProfilesChanged: false }, null, 2));
  } finally {
    window.webContents.session.protocol.unhandle('https');
    if (originalAvatarFixture === undefined) delete process.env.MODELDOCK_SMOKE_AVATAR_FIXTURE;
    else process.env.MODELDOCK_SMOKE_AVATAR_FIXTURE = originalAvatarFixture;
  }
}
