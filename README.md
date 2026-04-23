# zcc

Zero-Config Claude Bootstrap (Linux v1).

## 用法

```bash
npx zcc install
```

第一版仅包含三阶段：
1. 环境检查
2. Claude Code 安装（官方 curl / npm 兼容）
3. API/代理最小配置（保存到 `~/.zcc/config.json` 或 `~/.zcc/.env.zcc`）

> npm 安装链路仅作兼容，官方推荐 `curl -fsSL https://claude.ai/install.sh | bash`。
