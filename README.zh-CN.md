# dsh-plugin-toolkit

> 诊断并修复 DSH 插件装载问题。

**简体中文** | [English](README.md)

三个独立脚本，专治那些让插件**装了却从不运行**的故障。无依赖、无构建步骤，纯 Node。

它们存在的理由：这类故障都是静默的——退出码常常是 0，日志里什么都没有，插件就是不起作用。

---

## 三种故障

| 故障 | 症状 | 工具 |
|---|---|---|
| **半成品状态** —— 包实体进了 `node_modules`，但依赖声明或 bundle 注册缺失 | 「装完了但插件不生效」 | `install-selfcontained` |
| **三方不一致** —— `package.json`、`pnpm-lock.yaml`、`node_modules` 互相矛盾 | 一次半成功的安装，或之后 `--frozen-lockfile` 失败 | `diagnose-install` |
| **静默死亡** —— 装了、声明了、实体也在，**但名字不在 `dsh.profile.bundles` 里** | 什么都没有。无报错、无日志 | `lint-profile` |

第三种最危险，而且在本机真实撞上过：**两个插件死了好几个月**。它们装了、清单里有 `dsh.bundle.patch`、目录是实体——**却一次都没运行过**。

原因写在 `dsh-app-boot` 自己的模块注释里：

> the tree is composed by applying each bundle's patch lists in `dsh.profile.bundles` order **over an empty entry list**

树从空列表开始，只按 `bundles` 逐条叠加。名字不在其中的包，宿主**根本不会去看它**。

---

## 三个工具

### `lint-profile.mjs` —— 找出从未运行的插件

```powershell
node scripts/lint-profile.mjs                  # profile 默认 web
node scripts/lint-profile.mjs --profile tui
node scripts/lint-profile.mjs --all            # 全部本地插件
node scripts/lint-profile.mjs --json
```

把每个依赖项与四项事实对账，输出一张表：

```
插件                              实体    bundles  版本          状态
dsh-sovereign                   实体    是        0.4.0       OK
dsh-essence                     实体    否        0.1.0       !! 装了但未注册 — 不会生效
```

干净时退出码 0，有问题时 1——可用于 CI。

### `diagnose-install.mjs` —— 三方对账

```powershell
node scripts/diagnose-install.mjs                    # 当前目录的包
node scripts/diagnose-install.mjs --plugin <包名>
node scripts/diagnose-install.mjs --all
```

比对依赖声明、lockfile 记录、以及磁盘上实际存在的东西——**包括装的是实体目录还是符号链接**。客户端产物按清单声明的 `exports["./client"]` 定位，不猜路径，因此把产物放在 `./client.js` 或 `./client/client.js` 的插件都能正确处理。

### `install-selfcontained.mjs` —— 不经过 pnpm 安装

```powershell
node scripts/install-selfcontained.mjs --profile web
node scripts/install-selfcontained.mjs --profile web --dry-run
node scripts/install-selfcontained.mjs --profile web --uninstall
```

只做三件事，别的不碰：

1. 把实体复制进 `profile/node_modules/<name>/`
2. 写入 `dependencies[name] = "file:./node_modules/<name>"` —— **相对** spec
3. 把 `<name>` 加进 `dsh.profile.bundles`

相对 spec 加实体目录，意味着**整个 profile 可以搬到任何地方**，依赖依然解析得到。绝对 `file:` 路径和 `link:` spec 都会在搬迁后失效。

**已知代价，明说而非隐瞒：** 因为绕过了 pnpm，`pnpm-lock.yaml` 不会更新。脚本会检测到并打印补齐命令。若静默跳过，会留下一个将来 `pnpm install --frozen-lockfile` 失败的 profile。

---

## 工具本身的安装

无需安装——直接从检出目录运行：

```powershell
git clone https://github.com/MYCF711/dsh-plugin-toolkit
cd dsh-plugin-toolkit
node scripts/lint-profile.mjs
```

---

## 验证过的行为

```powershell
npm run verify      # 22 项检查
```

全部在隔离的临时目录中运行，**不触碰任何真实 profile**。

覆盖范围包括：检出装了但未注册的插件；已声明但缺实体；已注册但缺实体；健康 profile 报告干净；`install-selfcontained` 写入相对 spec 并注册 bundle；以及 `--dry-run` 完全零副作用。

---

## 上下文与 token 开销：零

这三个都不是 DSH 插件，是你自己运行的命令行脚本。不向运行时注册任何东西，不碰提示词，不自动运行。

真正值得配的 DSH 侧组件是 [dsh-plugin-doctor](https://github.com/MYCF711/dsh-plugin-doctor)，它在启动时锁定可用的 pnpm 版本——同样零提示词开销。

---

## 为什么会有这些东西

上面每一个故障都是在本机真实撞上的，从 DSH 源码里诊断出来，不是猜的。每个脚本头部的注释记录了实测到的结论、以及试过并否决的方案，让推理过程能留存下来。

---

## 许可证

[MIT](LICENSE) © 2026 MYCF711
