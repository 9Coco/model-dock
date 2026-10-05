import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Manual, pinned update only. This script never runs during app startup/build.
const DEFAULT_COMMIT = '737e3324305806514d7909874fa1818ae1808232';
const commit = process.argv[2] ?? DEFAULT_COMMIT;
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Pass a full reviewed Google repository commit SHA.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = join(root, 'src/renderer/assets/material-symbols');
const aliases = {
  Activity: 'monitor_heart', ArrowDownToLine: 'download', ArrowLeft: 'arrow_back', ArrowRight: 'arrow_forward', ArrowUpRight: 'north_east',
  BarChart3: 'monitoring', BookOpen: 'menu_book', Box: 'deployed_code', Check: 'check', CheckCheck: 'done_all', ChevronDown: 'keyboard_arrow_down',
  CircleHelp: 'help', Clock3: 'schedule', Copy: 'content_copy', Database: 'database', DollarSign: 'attach_money', Download: 'download',
  Ellipsis: 'more_horiz', Eye: 'visibility', FileCode2: 'code_blocks', FileText: 'description', FolderOpen: 'folder_open', Globe2: 'language',
  Info: 'info', KeyRound: 'key', Layers3: 'stacks', LoaderCircle: 'progress_activity', LogOut: 'logout', Monitor: 'desktop_windows',
  Moon: 'dark_mode', Pencil: 'edit', Plug2: 'power', Plus: 'add', Power: 'power_settings_new', Radio: 'sensors', RefreshCw: 'refresh',
  Repository: 'account_tree', RotateCcw: 'restart_alt', ScrollText: 'article', Search: 'search', Server: 'dns', Settings2: 'tune',
  ShieldCheck: 'verified_user', Sparkles: 'auto_awesome', Sun: 'sunny', Terminal: 'terminal', Trash2: 'delete', Unplug: 'power_off',
  Upload: 'upload', UserRound: 'person', Waypoints: 'hub', X: 'close', Zap: 'bolt',
};
const filled = new Set(['hub', 'dns', 'menu_book', 'key', 'monitoring', 'stacks', 'monitor_heart', 'tune', 'folder_open']);
const base = `https://raw.githubusercontent.com/google/material-design-icons/${commit}/`;
const runFile = promisify(execFile);
async function get(path) {
  // Windows PowerShell follows the host's network setup, unlike direct Node
  // fetch. The fixed URL is passed as data, outside the command text.
  if (process.platform === 'win32') {
    const command = '$ErrorActionPreference="Stop";[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$response=Invoke-WebRequest -Uri $env:MODELDOCK_ICON_SOURCE_URL -UseBasicParsing -TimeoutSec 30;$content=$response.Content;if($content -is [byte[]]){$content=[System.Text.Encoding]::UTF8.GetString($content)};[Console]::Write($content)';
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', maxBuffer: 128 * 1024, windowsHide: true, env: { ...process.env, MODELDOCK_ICON_SOURCE_URL: base + path } });
    return stdout;
  }
  const response = await fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Google icon download failed: ${path} (HTTP ${response.status}).`);
  const value = await response.text(); if (Buffer.byteLength(value) > 128 * 1024) throw new Error(`Unexpected large icon: ${path}.`); return value;
}
function parseSvg(svg, name) {
  const sourceViewBox = svg.match(/\bviewBox="([^"]+)"/)?.[1];
  const width = svg.match(/\bwidth="(\d+)"/)?.[1], height = svg.match(/\bheight="(\d+)"/)?.[1];
  // A few official 24px exports omit viewBox and use the SVG viewport itself.
  const viewBox = sourceViewBox ?? (width && height ? `0 0 ${width} ${height}` : undefined);
  if (!viewBox || !/^[-\d. ]+$/.test(viewBox) || /<(?:script|image|use|foreignObject|style)\b|\bon\w+=|\bhref=/i.test(svg)) throw new Error(`Unexpected SVG structure: ${name}.`);
  const paths = [...svg.matchAll(/<path\b([^>]+)>/g)].flatMap(match => {
    if (/\bfill="none"/.test(match[1])) return [];
    const d = match[1].match(/\bd="([^"]+)"/)?.[1];
    if (!d || !/^[MmLlHhVvCcSsQqTtAaZz\d.,+\-\s]+$/.test(d)) throw new Error(`Unexpected SVG path: ${name}.`);
    return [d];
  });
  if (!paths.length) throw new Error(`No symbol paths: ${name}.`);
  return { viewBox, paths, viewBoxDerivedFromSize: !sourceViewBox };
}
mkdirSync(folder, { recursive: true });
const names = [...new Set(Object.values(aliases))].sort();
const entries = [], registry = {};
let cursor = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < names.length) {
    const name = names[cursor++], path = `symbols/web/${name}/materialsymbolsrounded/${name}_24px.svg`, svg = await get(path), source = parseSvg(svg, name);
    writeFileSync(join(folder, `${name}.svg`), svg);
    const entry = { name, style: 'rounded', weight: 400, opticalSize: 24, grade: 0, fill: 0, source: base + path, sha256: createHash('sha256').update(svg).digest('hex'), viewBox: source.viewBox, viewBoxDerivedFromSize: source.viewBoxDerivedFromSize, pathCount: source.paths.length };
    const value = { viewBox: source.viewBox, outline: source.paths };
    if (filled.has(name)) {
      const filledPath = `symbols/web/${name}/materialsymbolsrounded/${name}_fill1_24px.svg`, filledSvg = await get(filledPath), selected = parseSvg(filledSvg, name);
      if (selected.viewBox !== source.viewBox) throw new Error(`Filled viewBox mismatch: ${name}.`);
      writeFileSync(join(folder, `${name}-filled.svg`), filledSvg); value.filled = selected.paths;
      entry.filled = { fill: 1, source: base + filledPath, sha256: createHash('sha256').update(filledSvg).digest('hex'), viewBox: selected.viewBox, pathCount: selected.paths.length };
    }
    entries.push(entry); registry[name] = value;
  }
}));
const license = await get('LICENSE'); writeFileSync(join(folder, 'LICENSE-Apache-2.0.txt'), license);
const sortedRegistry = Object.fromEntries(Object.entries(registry).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(folder, 'paths.ts'), `// Generated by scripts/update-material-symbols.mjs from Google Material Symbols.\n// Source commit: ${commit}; Apache-2.0; see LICENSE-Apache-2.0.txt and manifest.json.\nexport const materialSymbolPaths = ${JSON.stringify(sortedRegistry, null, 2)} as const;\nexport const materialIconNames = ${JSON.stringify(aliases, null, 2)} as const;\n`);
writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ family: 'Material Symbols Rounded', repository: 'https://github.com/google/material-design-icons', commit, license: 'Apache-2.0', axes: { weight: 400, opticalSize: 24, grade: 0, fill: 0 }, aliases, icons: entries.sort((a, b) => a.name.localeCompare(b.name)) }, null, 2) + '\n');
writeFileSync(join(folder, 'NOTICE.md'), `# Google Material Symbols\n\nThese SVG icons and derived React path registry originate from [Google Material Symbols](https://fonts.google.com/icons), published by Google LLC under the Apache License, Version 2.0.\n\nOfficial source: https://github.com/google/material-design-icons\nPinned commit: \`${commit}\`\nStyle: Rounded; weight 400; optical size 24; grade 0; fill 0. The nine main navigation icons additionally include the official fill 1 variant.\n\nSVG geometry is retained without modification. The React wrapper uses currentColor and local path arrays in place of Google Fonts; it makes no runtime font or icon network request. All SVG source URLs, SHA-256 hashes, viewBoxes, path counts and component aliases are recorded in manifest.json. Repository uses the generic account_tree symbol, which is not a GitHub logo. ModelDock and third-party tool brand artwork are separate assets.\n\nRegenerate only after reviewing a source revision: \`node scripts/update-material-symbols.mjs <40-character-commit>\`.\n`);
console.log(`Material Symbols pinned ${commit}: ${names.length} outline SVGs, ${filled.size} filled SVGs, ${Object.keys(aliases).length} component aliases.`);
