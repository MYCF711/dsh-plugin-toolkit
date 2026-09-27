/**
 * diagnose-install.mjs — 排查 DSH 插件安装不一致：
 * package.json 声明 / pnpm-lock.yaml 记录 / node_modules 实体 三者是否对得上。
 *
 * 为什么需要（实机踩坑）：pnpm 12.4.2 在部分 profile 配置下（hoisted linker
 * + 较大的包）安装会崩溃，崩完之后三者经常停在互相矛盾的状态 —— 声明里有
 * 依赖但没装、装了但 lockfile 没记。只看 `dsh plugin add` 的退出码判断不了，
 * 必须三方对账。
 *
 * 用法：
 *   node diagnose-install.mjs                        # 诊断当前目录的包
 *   node diagnose-install.mjs --plugin <包名>         # 诊断指定包
 *   node diagnose-install.mjs --profile tui          # 指定 profile（默认 web）
 *   node diagnose-install.mjs --all                  # 列出 profile 中全部本地插件
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const profileName = flag('profile', 'web');

// ── 定位 profile 目录 ──────────────────────────────────────────────
/** 从 DSH_HOME 推出 profile 目录；找不到时回退到默认 launcher 布局。 */
function findProfileDir(name) {
  const home = process.env.DSH_HOME;
  const candidates = [];
  if (home !== undefined) candidates.push(join(home, 'profiles', name));
  const appData = process.env.APPDATA;
  if (appData !== undefined) {
    const launcher = join(appData, 'in.dsh-plug.dsh-launcher');
    const homes = join(launcher, 'homes');
    if (existsSync(homes)) {
      for (const ver of readdirSync(homes)) candidates.push(join(homes, ver, 'profiles', name));
    }
  }
  return candidates.find((c) => existsSync(c));
}

const profileDir = findProfileDir(profileName);
if (profileDir === undefined) {
  console.error(`找不到 profile "${profileName}" 的目录`);
  process.exit(1);
}

/**
 * 解析要诊断的包名，按优先级：
 *   1. --all：列出 profile 中全部本地（file:/link:）插件
 *   2. --plugin <name>
 *   3. 当前目录 package.json 的 name（在插件工程里直接跑）
 * 显式传入的模式优先于当前目录推断，否则 `--all` 在插件工程里会退化成单包模式。
 */
function resolvePluginNames() {
  const listAll = has('all');
  const explicit = flag('plugin', undefined);

  /** 从 profile 清单里挑出全部本地 spec 的插件名。 */
  const localPlugins = () => {
    const profilePkg = join(profileDir, 'package.json');
    if (!existsSync(profilePkg)) return [];
    const p = JSON.parse(readFileSync(profilePkg, 'utf8'));
    return Object.entries(p.dependencies ?? {})
      .filter(([, spec]) => {
        const s = String(spec);
        return s.startsWith('file:') || s.startsWith('link:');
      })
      .map(([name]) => name);
  };

  if (listAll) return localPlugins();
  if (explicit !== undefined) return [explicit];

  const local = join(process.cwd(), 'package.json');
  if (existsSync(local)) {
    try {
      const p = JSON.parse(readFileSync(local, 'utf8'));
      if (typeof p.name === 'string' && p.name !== '') return [p.name];
    } catch {
      /* 当前目录没有可读清单，退回全列 */
    }
  }
  return localPlugins();
}

const pluginNames = resolvePluginNames();
if (pluginNames.length === 0) {
  console.error('无法确定要诊断的插件。请用 --plugin <包名> 指定。');
  process.exit(1);
}

console.log(`profile: ${profileDir}`);
console.log(`插件: ${pluginNames.join(', ')}`);
console.log('');

/** 诊断单个插件，返回是否全部正常。 */
function diagnosePlugin(PLUGIN) {
  const findings = [];
  const report = (label, ok, detail) => {
    findings.push({ label, ok });
    console.log(`  ${ok ? 'OK  ' : 'WARN'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  };

// ── 源 1：package.json 声明 ────────────────────────────────────────
const manifestPath = join(profileDir, 'package.json');
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : undefined;
const declared = manifest?.dependencies?.[PLUGIN];
report(
  'package.json 有依赖声明',
  declared !== undefined,
  declared === undefined ? '未声明' : `"${declared}"`,
);

// ── 源 2：lockfile ─────────────────────────────────────────────────
const lockPath = join(profileDir, 'pnpm-lock.yaml');
let locked;
if (existsSync(lockPath)) {
  const text = readFileSync(lockPath, 'utf8');
  // 只做存在性抽取，不引 yaml 依赖：lockfile 里该包的 importer 条目形如
  //   dsh-escape-hatch:
  //     specifier: ...
  //     version: ...
  const m = new RegExp(
    `^\\s{2,}${PLUGIN}:\\s*\\n\\s+specifier: (.+)\\n\\s+version: (.+)`,
    'm',
  ).exec(text);
  locked = m === null ? undefined : { specifier: m[1].trim(), version: m[2].trim() };
  report('lockfile 有解析记录', locked !== undefined, locked === undefined ? '未记录' : JSON.stringify(locked));
} else {
  report('lockfile 存在', false, 'pnpm-lock.yaml 不存在');
}

// ── 源 3：实际安装 ─────────────────────────────────────────────────
const installedDir = join(profileDir, 'node_modules', PLUGIN);
const installed = existsSync(installedDir);
let installedVersion;
let linkKind = '实体目录';
if (installed) {
  const st = statSync(installedDir);
  if (st.isSymbolicLink?.() === true || (st.mode & 0o170000) === 0o120000) linkKind = '符号链接';
  const pj = join(installedDir, 'package.json');
  let installedPkg;
  if (existsSync(pj)) {
    installedPkg = JSON.parse(readFileSync(pj, 'utf8'));
    installedVersion = installedPkg.version;
  }

  // 客户端产物检查：路径以清单声明的 exports["./client"] 为准，
  // 不猜目录。不同插件的产物位置不同（lib/client.js、client.js、dist/…），
  // 硬编码 lib/client.js 会对别的插件产生假警报。
  const clientEntry = installedPkg?.exports?.['./client'];
  if (typeof clientEntry === 'string') {
    const clientPath = join(installedDir, clientEntry);
    const ok = existsSync(clientPath);
    report('客户端产物存在', ok, ok ? clientEntry : `缺失 ${clientEntry}`);
  } else {
    // 未声明 ./client：可能是纯宿主插件，不算问题。
    report('客户端半边', true, '未声明 exports["./client"]（纯宿主插件）');
  }

  // bundle 注册（真正决定插件是否生效的地方）
  const profilePkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  const inBundles = (profilePkg.dsh?.profile?.bundles ?? []).includes(PLUGIN);
  report('已登记进 dsh.profile.bundles', inBundles, inBundles ? '是' : '否（插件不会生效）');
}
report(
  'node_modules 有实体',
  installed,
  installed ? `${linkKind}${installedVersion === undefined ? '' : `, v${installedVersion}`}` : '未安装',
);

// ── 一致性结论 ─────────────────────────────────────────────────────
  console.log('');
  const three = [declared !== undefined, locked !== undefined, installed];
  const allTrue = three.every(Boolean);
  const allFalse = three.every((v) => !v);

  if (allTrue) {
    console.log('三方一致：声明 / lockfile / node_modules 均有记录。');
    // 版本一致性只在「两边都是语义化版本号」时才可比较。
    // file:/link:/git:/http: 这些 spec 的 lockfile version 字段是路径或 URL，
    // 拿它去比对磁盘上的 v1.0.0 只会产生假警报。
    const lockedVer = locked?.version;
    const comparable =
      typeof lockedVer === 'string' && /^\d+\.\d+/.test(lockedVer) && installedVersion !== undefined;
    if (comparable && !lockedVer.startsWith(installedVersion)) {
      console.log(`注意：lockfile 版本 (${lockedVer}) 与磁盘版本 (${installedVersion}) 不一致。`);
      console.log(`      重装：node scripts/install-selfcontained.mjs --profile ${profileName}`);
    } else if (!comparable) {
      console.log('（lockfile 记录为非语义化 spec，跳过版本比对）');
    }
  } else if (allFalse) {
    console.log('三方均无记录：该插件当前未安装。');
    console.log(`安装：node scripts/install-selfcontained.mjs --profile ${profileName}`);
  } else {
    console.log('不一致！三者状态：');
    console.log(`  package.json 声明 : ${String(declared !== undefined)}`);
    console.log(`  lockfile 记录     : ${String(locked !== undefined)}`);
    console.log(`  node_modules 实体 : ${String(installed)}`);
    console.log('');
    // 这种状态多半是 `dsh plugin add` 在写清单前崩溃留下的。
    // 不要再用 pnpm 重试（会再次崩），直接用不依赖 pnpm 的直装脚本。
    console.log('这种状态通常由 `dsh plugin add` 在写入清单前崩溃造成。');
    console.log('修复（不经过 pnpm，不会再次崩溃）：');
    console.log(`  node scripts/install-selfcontained.mjs --profile ${profileName}`);
  }

  const warned = findings.filter((f) => !f.ok).length;
  console.log('');
  console.log(`  小结：${String(findings.length - warned)}/${String(findings.length)} 项正常`);
  return warned === 0;
}

// ── 逐个诊断 ───────────────────────────────────────────────────────
let allOk = true;
for (const pluginName of pluginNames) {
  if (pluginNames.length > 1) console.log(`── ${pluginName} ──`);
  const ok = diagnosePlugin(pluginName);
  if (!ok) allOk = false;
  if (pluginNames.length > 1) console.log('');
}

if (pluginNames.length > 1) {
  const bad = pluginNames.length;
  console.log(`diagnose-install: 共诊断 ${String(bad)} 个插件${allOk ? '，全部正常' : '，其中有异常项（见上）'}`);
}
process.exit(allOk ? 0 : 1);
