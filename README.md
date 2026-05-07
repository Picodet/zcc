# zcc

Zero-Config Claude Bootstrap (Linux v1).

## 用法

```bash
npx @picodet/zcc install
```

第一版当前可用与预留：
1. 环境检查
2. Claude Code 安装（官方 curl / npm 兼容）
3. API/代理最小配置（支持“配置名称 + API Base URL + API Key”；`.env.zcc` 默认留空 `ZCC_API_KEY` 供用户手填）
4. Skills 导入（优先使用包内置 `assets/paper_skills_zip.zip`；可用 `ZCC_SKILLS_ZIP` 覆盖；目标目录默认 `~/.claude/skills`，可用 `ZCC_CLOUD_SKILLS_DIR` 覆盖）
5. 飞书初始化（在 Cloud skills 目录执行 `npx @larksuite/cli@latest install`，并生成 `<Cloud skills>/飞书初始化/SKILL.md`）

> npm 安装链路仅作兼容，官方推荐 `curl -fsSL https://claude.ai/install.sh | bash`。
