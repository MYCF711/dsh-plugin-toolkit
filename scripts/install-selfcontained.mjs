/**
 * install-selfcontained.mjs — 把插件以「自包含」形态装进 profile。
 *
 * ── 为什么需要它（实机缺陷，非推测） ──────────────────────────────────
 *
 * `dsh plugin add` 最终调用 pnpm。在 pnpm 12.4.2 + hoisted linker 的
 * profile 上，它对本地目录 / git / 大包路径会申请约 20GB 内存后崩溃：
 *
 *     memory allocation of 21474836480 bytes failed
 *
 * 实测三种入口都会触发：`file:<绝对 tgz>`、`github:`、`file:./dir`。
 * 崩溃点在写入 package.json **之前**，于是留下一个矛盾状态：
 * node_modules 里实体已就位，但依赖声明没写、bundle 没注册 ——
 * 表现为「装完了但插件不生效」，而且退出码有时仍为 0。
 *
 * 关键认识：**这类插件的安装根本不需要 pnpm。**
 * 插件就是一个目录加两行清单登记，没有任何依赖解析工作要做。
 * 本脚本直接做那两件事，因此绕开了整条会崩的路径，且结果与
 * `dsh plugin add` 的产物完全一致（同样的相对 spec、同样的 bundle 登记）。
 *
 * ── 产物形态 ─────────────────────────────────────────────────────────
 *
 *   1. profile/node_modules/<name>/         实体目录（非符号链接）
 *   2. package.json → dependencies[name]    "file:./node_modules/<name>"
 *   3. package.json → dsh.profile.bundles   含 <name>
 *
 * 相对 spec + 实体目录 = 整个 profile 可直接搬走，依赖关系原样成立。
 * 这也是本机其它本地插件（dsh-sovereign / dsh-essence / …）的既有形态。
 *
 * 用法：
 *   node scripts/install-selfcontained.mjs                    # 装到 web
 *   node scripts/install-selfcontained.mjs --profile tui
 *   node scripts/install-selfcontained.mjs --dry-run          # 只报告不改动
 *   node scripts/install-selfcontained.mjs --uninstall
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const profileName = flag('profile', 'web');
const dryRun = has('dry-run');
const uninstall = has('uninstall');

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = pkg.name;

// ── 定位 profile 目录 ──────────────────────────────────────────────
/**
 * 找到 profile 目录。优先 DSH_HOME，其次从默认 launcher 布局回推。
 * @returns profile 目录绝对路径，或 undefined。
 */
function findProfileDir(profile) {
  const candidates = [];
  if (process.env.DSH_HOME !== undefined) {
    candidates.push(join(process.env.DSH_HOME, 'profiles', profile));
  }
  const appData = process.env.APPDATA;
  if (appData !== undefined) {
    const homes = join(appData, 'in.dsh-plug.dsh-launcher', 'homes');
    if (existsSync(homes)) {
      for (const ver of readdirSync(homes)) {
        candidates.push(join(homes, ver, 'profiles', profile));
      }
    }
  }
  return candidates.find((c) => existsSync(c));
}

const profileDir = findProfileDir(profileName);
if (profileDir === undefined) {
  console.error(`找不到 profile "${profileName}"`);
  process.exit(1);
}
const manifestPath = join(profileDir, 'package.json');
const targetDir = join(profileDir, 'node_modules', name);
const spec = `file:./node_modules/${name}`;

console.log(`profile   : ${profileDir}`);
console.log(`plugin    : ${name}@${pkg.version}`);
console.log(`mode      : ${uninstall ? 'uninstall' : dryRun ? 'dry-run' : 'install'}`);
console.log('');

// ── 清单读写 ───────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.dependencies ??= {};
// bundles 是插件真正的注册位置（不是 cordis.patch.yml 的 insert 列表）。
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
const bundles = manifest.dsh.profile.bundles;

/** 依 package.json 的 files 白名单复制，保持运行所需的最小集合。 */
function copyPayload() {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  // 始终包含清单与 dsh 声明所引用的路径。
  const always = ['package.json', 'cordis.patch.yml', 'README.md', 'README.zh-CN.md', 'LICENSE'];
  for (const f of always) {
    const from = join(root, f);
    if (existsSync(from)) copyFileSync(from, join(targetDir, f));
  }
  // files 白名单里的目录（lib/ 是运行时真正消费的产物）。
  for (const entry of pkg.files ?? []) {
    const from = join(root, entry);
    if (!existsSync(from)) continue;
    const to = join(targetDir, entry);
    if (statSync(from).isDirectory()) {
      copyDir(from, to);
    } else {
      mkdirSync(join(to, '..'), { recursive: true });
      copyFileSync(from, to);
    }
  }
}

/** 递归复制目录。 */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

if (uninstall) {
  // 顺序有意为之：先摘登记，再删目录。
  const hadDep = Object.hasOwn(manifest.dependencies, name);
  const bundleIdx = bundles.indexOf(name);
  delete manifest.dependencies[name];
  if (bundleIdx >= 0) bundles.splice(bundleIdx, 1);

  if (dryRun) {
    console.log(`[dry-run] 将移除 dependencies["${name}"] = ${String(hadDep)}`);
    console.log(`[dry-run] 将移除 bundles 中的 "${name}" = ${String(bundleIdx >= 0)}`);
    console.log(`[dry-run] 将删除目录 ${targetDir}`);
  } else {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    rmSync(targetDir, { recursive: true, force: true });
    console.log(`已卸载：${name}`);
    console.log('  已从 dependencies 移除');
    console.log('  已从 dsh.profile.bundles 移除');
    console.log(`  已删除 ${targetDir}`);
  }
  process.exit(0);
}

// ── 安装 ───────────────────────────────────────────────────────────
// 一致性预检：目标目录若是个符号链接，pnpm 的 add 会读不到清单而报
// os error 1921。自包含形态要求实体目录，这里显式拦下并说明。
if (existsSync(targetDir)) {
  const st = lstatSync(targetDir);
  const isLink = (st.mode & 0o170000) === 0o120000;
  if (isLink) {
    console.log(`注意：现有 ${name} 是符号链接，将被替换为实体目录（自包含形态）。`);
  }
}

if (dryRun) {
  console.log(`[dry-run] 将写入 dependencies["${name}"] = "${spec}"`);
  console.log(`[dry-run] 将把 "${name}" 加入 dsh.profile.bundles`);
  console.log(`[dry-run] 将复制插件实体到 ${targetDir}`);
  process.exit(0);
}

copyPayload();
console.log(`[1/3] 实体已就位：${targetDir}`);

manifest.dependencies[name] = spec;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[2/3] 依赖声明已写入：dependencies["${name}"] = "${spec}"`);

if (!bundles.includes(name)) {
  bundles.push(name);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[3/3] bundle 已注册：dsh.profile.bundles（共 ${String(bundles.length)} 项）`);
} else {
  console.log(`[3/3] bundle 已在注册列表中，无需重复添加`);
}

// ── 自检 ───────────────────────────────────────────────────────────
const check = [];
const finalManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
check.push(['依赖声明为相对 spec', finalManifest.dependencies[name] === spec]);
check.push(['目录为实体（非符号链接）', !((lstatSync(targetDir).mode & 0o170000) === 0o120000)]);
check.push(['bundles 已含插件', finalManifest.dsh.profile.bundles.includes(name)]);

// 客户端产物按清单声明的 exports["./client"] 定位，不猜路径。
// 纯宿主插件没有该导出，属正常情况。
const installedPkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'));
const clientEntry = installedPkg.exports?.['./client'];
if (typeof clientEntry === 'string') {
  check.push([`客户端产物存在（${clientEntry}）`, existsSync(join(targetDir, clientEntry))]);
} else {
  check.push(['纯宿主插件（无 ./client 导出）', true]);
}

// ── lockfile 一致性 ────────────────────────────────────────────────
//
// 本脚本直接写 package.json，**绕过了 pnpm**，因此 pnpm-lock.yaml 不会
// 自动更新。这是本方法的固有代价：pnpm 下次 install 时可能因 lockfile
// 与清单不符而重解析，或让 `pnpm install --frozen-lockfile` 失败。
//
// 所以这里必须**主动检测并明确提示**，而不是假装没发生 —— 早先版本正是
// 因为静默跳过这一步，导致 profile 里留下 lockfile 缺记录的状态。
const lockPath = join(profileDir, 'pnpm-lock.yaml');
let lockHasEntry = false;
if (existsSync(lockPath)) {
  lockHasEntry = new RegExp(`^\\s+${name}:`, 'm').test(readFileSync(lockPath, 'utf8'));
}
if (existsSync(lockPath)) {
  check.push(['lockfile 已记录该依赖', lockHasEntry]);
}

console.log('');
for (const [label, ok] of check) console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}`);
const bad = check.filter(([, ok]) => !ok);

if (!lockHasEntry && existsSync(lockPath)) {
  console.log('');
  console.log('lockfile 未记录该依赖（本脚本绕过了 pnpm，属预期）。补齐：');
  console.log(`  cd "${profileDir}" && pnpm install --lockfile-only`);
  console.log('若不补齐，`pnpm install --frozen-lockfile` 会因清单与 lockfile 不符而失败。');
}

console.log('');
console.log(bad.length === 0 ? '完成。' : `${String(bad.length)} 项检查未通过。`);
console.log('重启 DSH web 服务并刷新页面后生效。');
if (bad.length > 0) process.exit(1);
