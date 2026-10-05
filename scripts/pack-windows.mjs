import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arch, build, Platform } from 'electron-builder';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portable = process.argv.slice(2).includes('--portable');
const unsupported = process.argv.slice(2).filter(arg => arg !== '--portable');

function runNode(filename, args = []) {
  execFileSync(process.execPath, [filename, ...args], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
}

function electronArchitecture(filename) {
  // The installed runtime may differ from the host (e.g. ELECTRON_INSTALL_ARCH).
  const descriptor = openSync(filename, 'r');
  try {
    const dos = Buffer.alloc(64);
    const pe = Buffer.alloc(6);
    if (readSync(descriptor, dos, 0, dos.length, 0) !== dos.length || dos.readUInt16LE(0) !== 0x5a4d
      || readSync(descriptor, pe, 0, pe.length, dos.readUInt32LE(0x3c)) !== pe.length || pe.readUInt32LE(0) !== 0x4550) {
      throw new Error('本机 Electron 不是有效的 Windows 可执行文件，请重新安装依赖。');
    }
    const architecture = { 0x8664: Arch.x64, 0xaa64: Arch.arm64, 0x14c: Arch.ia32 }[pe.readUInt16LE(4)];
    if (architecture === undefined) throw new Error('本机 Electron 架构暂不支持 Windows 打包。');
    return architecture;
  } finally {
    closeSync(descriptor);
  }
}

function appMayBeRunning() {
  // A separate output also protects packages in the tray. Never stop the app.
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const count = execFileSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "@(Get-Process -Name 'ModelDock' -ErrorAction SilentlyContinue).Count",
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
    return !/^0$/.test(count);
  } catch {
    // If process inspection is unavailable, preserve the existing delivery.
    console.warn('无法确认旧包是否运行，将使用独立输出目录。');
    return true;
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows 包请在 Windows 上构建；Linux 请使用 npm run dist:linux。');
  if (unsupported.length) throw new Error('支持的参数：--portable（生成单文件便携 EXE）。');
  const electronDist = join(root, 'node_modules', 'electron', 'dist');
  if (!existsSync(join(electronDist, 'electron.exe'))) {
    throw new Error('缺少本机 Electron。先运行 npm ci；若安装脚本未运行，执行 npm rebuild electron 后重试。');
  }
  const architecture = electronArchitecture(join(electronDist, 'electron.exe'));
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) throw new Error('请使用 npm run pack:win 启动此脚本。');

  console.log('开始构建最新源码…');
  runNode(npmCli, ['run', 'build']);
  runNode(join(root, 'scripts', 'verify-production-build.mjs'));

  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  // Check immediately before packaging, after compilation has finished.
  const separate = appMayBeRunning();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = separate ? join(root, 'release', `windows-${version}-${stamp}-${process.pid}`) : join(root, 'release');
  if (separate) console.log('检测到运行中的 ModelDock，新包将放入独立目录。');
  console.log(`打包输出：${output}`);

  const artifacts = await build({
    projectDir: root,
    targets: Platform.WINDOWS.createTarget(portable ? 'portable' : 'dir', architecture),
    publish: 'never',
    config: {
      electronDist,
      directories: { output },
      win: { signExecutable: false, signAndEditExecutable: true },
    },
  });
  const folder = join(output, 'win-unpacked');
  runNode(join(root, 'scripts', 'verify-windows-package.mjs'), [folder]);
  if (portable) for (const artifact of artifacts) {
    if (artifact.toLowerCase().endsWith('.exe')) runNode(join(root, 'scripts', 'verify-exe-icon.mjs'), [artifact]);
  }

  console.log(`\n打包完成：${join(folder, 'ModelDock.exe')}`);
  if (portable) for (const artifact of artifacts) console.log(`便携程序：${artifact}`);
  else console.log('分发时请复制整个 win-unpacked 文件夹；需要单文件 EXE 可运行 npm run dist:win。');
}

main().catch(error => {
  console.error(`打包失败：${error.message}`);
  process.exitCode = 1;
});
