# Auto-Git

Repo Deployer 是一个基于 Tauri 的桌面工具，用来把本地文件夹快速绑定到 Git 仓库，并完成提交、推送以及可选部署。

## 当前支持

- 输入 Git 仓库地址后选择本地文件夹
- 检测仓库地址格式、远程可达性、默认分支和远程分支列表
- 检测当前机器或当前仓库的 Git 用户名、邮箱
- 如果文件夹还没初始化 Git，会自动执行 `git init`
- 如果没有 `origin`，会自动绑定远程仓库
- 自动切到指定分支，默认优先使用远程默认分支，否则使用 `main`
- 自动执行 `git add -A`、`git commit`、`git push -u origin <branch>`
- 如果远程分支已存在，会先尝试 `git pull --allow-unrelated-histories`
- 支持可选部署命令，例如 `npm run deploy`
- 支持保存多个项目配置，方便重复使用

## 使用流程

1. 填写 Git 仓库地址。
2. 选择本地文件夹。
3. 点击“检测仓库连接”，确认远程能连通、默认分支是否识别成功。
4. 如有需要，补充 Git 用户名和邮箱。
5. 点击“初始化并提交到仓库”或“提交后执行部署”。

## 运行前提

需要本机安装这些工具：

- Node.js
- Git
- Rust 工具链
- Tauri Windows 前置依赖

## 启动方式

```bash
npm install
npm run tauri:dev
```

如果你只是想先检查前端构建：

```bash
npm run build
```

如果要打 Windows 安装包：

```bash
npm run tauri:build
```

如果只想生成可直接运行的 exe：

```bash
npm run tauri:exe
```

默认安装包输出位置：

```text
src-tauri/target/release/bundle/nsis/Repo Deployer_0.1.0_x64-setup.exe
```

## 首次同步说明

- 如果远程仓库已经有提交历史，而本地文件夹也是一套现成文件，工具会尝试自动合并历史。
- 如果存在同名文件冲突，仍然需要手动处理一次冲突，再重新点击同步。
- 如果使用 HTTPS 仓库，通常需要先准备好平台令牌或 Git Credential Manager 登录。
- 如果使用 SSH 仓库，需要确保本机 SSH Key 已经添加到远程平台。
