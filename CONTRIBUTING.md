# 算力资源台：协作开发和上线

**同事在 GitHub 提 PR → 你把 PR 链接发给 Codex → Codex 检查、合并并发布现有网站。**

- [公开 GitHub 仓库](https://github.com/MoCuishle-M/server-resource-dashboard)：共享源码，主分支是 `main`，任何人都可以查看和克隆代码。
- [线上算力资源台](https://server-resource-dashboard.zhangxubin2425.chatgpt.site)：发布目标是现有 ChatGPT Sites 站点。
- PR 是「把我的修改合入主分支」的请求。GitHub 检查通过、PR 已合并、网站已上线，是三个不同状态。

## 你：首次设置

1. 同事可以直接查看和克隆公开仓库。需要让他在原仓库推送分支时，打开 [Settings → Collaborators](https://github.com/MoCuishle-M/server-resource-dashboard/settings/access)，点 **Add people**，按同事的 **GitHub 用户名**邀请；没有写入权限的贡献者可先 Fork 仓库，在自己的仓库修改后向本仓库提交 PR。
2. 把本页和仓库地址发给他，约定每次修改都开分支提 PR。发布仍由你登录的 Codex 操作，不用给他 Sites 权限或生产密钥。
3. 以后在有此仓库源码、且能访问原站点的 Codex 聊天里发 PR 链接和本页末尾的指令。**这条指令同时授权合并和上线**；检查通过后无需再发一次确认。

## 同事：每次修改怎么提交

首次将仓库下载到本机。需要 Git 和 Node.js 22.13 或以上：

```bash
git clone https://github.com/MoCuishle-M/server-resource-dashboard.git
cd server-resource-dashboard
```

每次从最新的 `main` 新开分支。下面用修改排期筛选举例：

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/schedule-filter
npm ci
npm run dev -- --port 5173
```

打开 [本地演示页](http://127.0.0.1:5173/demo) 用示例数据试功能。涉及登录、数据库或角色权限时，按 [README 的本地运行说明](README.md#本地运行) 准备本地数据库，并按顺序应用未执行的迁移。日常测试使用本地数据。

改完后运行 `npm run typecheck`、`npm test` 和 `npm run build`。用 `git status` 确认改动，只暂存本次修改的文件，提交并推送：

```bash
git add -- <实际修改的文件路径>
git commit -m "完善排期筛选"
git push -u origin feat/schedule-filter
```

在 GitHub 点 **Compare & pull request**，确认目标分支（base）是 `main`，来源分支（compare）是你的功能分支。PR 描述写清楚：

```text
改了什么：原来怎样，现在怎样。
怎么验证：运行过的命令，以及在 /demo 或本地验证的操作。
上线影响：是否改变数据库结构、权限、登录或配置；没有就写“无”。
```

把 PR 链接发给网站负责人。检查失败就在原分支修好并重新推送，GitHub 会更新同一个 PR。真实台账、账号密码、生产库导出和个人环境文件不提交到仓库。

## Codex：收到合并上线指令后

1. **定位改动。** 核对 PR 属于本仓库且目标是 `main`；读取最新提交、差异、评论和检查状态。若已经合并，确认合并记录及线上版本，按需要接着发布，避免重复操作。
2. **审核和验证。** 检查明显缺陷及权限、登录、数据库迁移、生产配置和敏感数据方面的影响。检查 PR 最新提交上的 **Validate dashboard**；还在跑就等结果，失败则报告具体原因。必要时用本地数据库或 `/demo` 补测。遇到合并冲突、阻塞问题、破坏性迁移或权限不足，停在对应步骤并说明。正常的合并和发布按用户本次指令继续。
3. **合并并锁定发布提交。** 用 GitHub 合并功能合入刚检查过的 PR 最新提交。重新拉取远端 `main`，确认包含该 PR，记录将要发布的完整 SHA。如果期间还有别的 PR 合入，要验证实际将要发布的整份代码；不能顺带发布未经检查的改动。用干净的检出目录构建，保留用户本地未提交的工作。
4. **发布到原 Sites。** 按当前 Sites 技能执行。读取仓库 `.openai/hosting.json` 的原项目 ID，核对原站网址、访问范围及当前版本。GitHub 和 Sites 各有自己的源码远端：用 Sites 的源码工作流同步将要部署的提交、构建打包、保存版本并部署；确认包与 Sites 上推送的提交一致。如果两边源码分叉，先核对并协调差异，不能强推覆盖；若协调发现未审核的线上改动，停止发布并说明。保留原站访问策略、数据库绑定和生产配置。涉及数据库迁移时，发布前检查对已有数据的影响。
5. **核实并回报。** 等 Sites 部署返回明确的成功或失败，成功后对线上网址做与本次改动相关的只读验证，避免写入测试预约。回复包含 PR 链接、合并提交、测试结果、Sites 版本和网址。若合并成功但发布失败，明确分开报告两个结果；涉及迁移时先确认数据库状态再重试，代码回退不会自动还原数据库。

## 你每次发给 Codex 的话

```text
请按仓库 CONTRIBUTING.md 的“Codex：收到合并上线指令后”处理这个 PR：
<粘贴 GitHub PR 链接>

审核最新提交并等待检查通过。通过后请直接合入 main，并把验证过的代码发布到现有「算力资源台」Sites 网站。保留原网址、访问权限和生产数据。正常合并和发布无需再问我；有阻塞就停在对应步骤并告诉我原因。最后告诉我是否已合并、是否已上线，以及提交、Sites 版本和网址。
```
