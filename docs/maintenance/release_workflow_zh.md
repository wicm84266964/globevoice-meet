# GitHub 发布流程

本仓库采用单人维护、CI 强制验收的流程。日常开发不直接推送 `main`。

1. 从最新 `main` 创建主题分支并完成修改。
2. 本地运行后端 smoke test，以及前端 `npm run lint` 和 `npm run build`。
3. 检查提交清单，排除会议音频、API 凭据、运行配置和打包产物。
4. 推送主题分支并创建 Pull Request。
5. 等待必需的 `application validation` 检查变绿，再合并。

不要求第二个人批准；CI 通过是不能跳过的批准条件。Windows 便携版打包和真实音频设备属于发布前人工验收，不放进常规 CI。

发布时，在 GitHub Actions 页面运行 `Create release`，选择 `main` 并填写新的 `vMAJOR.MINOR.PATCH`。工作流会复核 CI、创建不可变 tag 和 GitHub Release。不要手工创建、移动或覆盖公开 tag。
