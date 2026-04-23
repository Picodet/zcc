import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const VERSION = '0.1.1';
const OFFICIAL_INSTALL_CMD = 'curl -fsSL https://claude.ai/install.sh | bash';
const NPM_INSTALL_CMD = 'npm install -g @anthropic-ai/claude-code';

/**
 * 插件接口（预留）
 * plugin = {
 *   id: string,
 *   phase: 4 | 5,
 *   description: string,
 *   run: async (context) => ({ status: 'ok'|'skipped'|'failed', message: string, details?: object })
 * }
 */
const pluginRegistry = {
  4: [],
  5: [],
};

function registerPhasePlugin(phase, plugin) {
  if (![4, 5].includes(phase)) {
    throw new Error(`Unsupported phase: ${phase}`);
  }
  pluginRegistry[phase].push(plugin);
}

async function runPhasePlugins(phase, context) {
  const plugins = pluginRegistry[phase] || [];
  if (plugins.length === 0) {
    return [{ id: 'none', status: 'skipped', message: '没有已注册插件' }];
  }

  const results = [];
  for (const plugin of plugins) {
    try {
      const result = await plugin.run(context);
      results.push({ id: plugin.id, ...result });
    }
    catch (error) {
      results.push({
        id: plugin.id,
        status: 'failed',
        message: error?.message || String(error),
      });
    }
  }
  return results;
}

// v0.1.x 仅做接口占位，不执行真实导入/飞书初始化
registerPhasePlugin(4, {
  id: 'skills-import-placeholder',
  phase: 4,
  description: 'Skills 导入插件接口占位',
  run: async () => ({
    status: 'skipped',
    message: 'Phase 4 插件接口已就位，真实 skills 导入逻辑待接入。',
  }),
});

registerPhasePlugin(5, {
  id: 'feishu-bootstrap-placeholder',
  phase: 5,
  description: '飞书初始化插件接口占位',
  run: async () => ({
    status: 'skipped',
    message: 'Phase 5 插件接口已就位，真实飞书初始化逻辑待接入。',
  }),
});

function banner() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║                                                      ║');
  console.log('║ ███████╗ ██████╗ ██████╗                             ║');
  console.log('║ ╚══███╔╝██╔════╝██╔════╝                             ║');
  console.log('║   ███╔╝ ██║     ██║                                  ║');
  console.log('║  ███╔╝  ██║     ██║                                  ║');
  console.log('║ ███████╗╚██████╗╚██████╗ for Claude Code             ║');
  console.log('║                                                      ║');
  console.log('║ Zero-Config Claude Bootstrap (Linux v1)              ║');
  console.log('║                                                      ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`Version: ${VERSION}`);
  console.log('');
}

function usage() {
  console.log('请选择功能');
  console.log('1. 完整初始化（Linux）');
  console.log('Q. 退出');
  console.log('');
  console.log('或直接执行：zcc install');
}

function commandExists(cmd) {
  const p = spawnSync('bash', ['-lc', `command -v ${cmd}`], { encoding: 'utf-8' });
  return p.status === 0;
}

function run(command, dryRun = false) {
  if (dryRun) {
    console.log(`🧪 [dry-run] ${command}`);
    return { status: 0 };
  }
  return spawnSync('bash', ['-lc', command], { stdio: 'inherit' });
}

function maskSecret(key = '') {
  if (!key) return '(empty)';
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}${'*'.repeat(key.length - 8)}${key.slice(-4)}`;
}

async function ask(rl, q) {
  const ans = await rl.question(q);
  return ans.trim();
}

function phase0EnvironmentCheck() {
  console.log('[1/5] 环境检查');
  const checks = [
    { name: 'bash', ok: commandExists('bash') },
    { name: 'curl', ok: commandExists('curl') },
    { name: 'git', ok: commandExists('git') },
    { name: 'node', ok: commandExists('node') },
    { name: 'npm', ok: commandExists('npm') },
  ];

  const isLinux = os.platform() === 'linux';
  const shell = process.env.SHELL || '(unknown)';
  const localBin = path.join(os.homedir(), '.local/bin');
  const inPath = (process.env.PATH || '').split(':').includes(localBin);

  console.log(`- OS: ${os.platform()} ${isLinux ? '✅' : '❌ (仅支持 Linux)'} `);
  checks.forEach((c) => console.log(`- ${c.name}: ${c.ok ? '✅' : '❌'}`));
  console.log(`- 当前 shell: ${shell}`);
  console.log(`- ~/.local/bin 在 PATH: ${inPath ? '✅' : '❌'}`);

  const missing = checks.filter((c) => !c.ok).map((c) => c.name);
  if (!isLinux || missing.length > 0) {
    console.log('\n❌ 环境检查失败：');
    if (!isLinux) console.log('  - 当前系统不是 Linux');
    if (missing.length > 0) console.log(`  - 缺少命令：${missing.join(', ')}`);
    console.log('请先修复后再执行 zcc install。');
    return { ok: false, shell, inPath };
  }

  if (!inPath) {
    console.log('\n⚠️ 提示：~/.local/bin 不在 PATH，后续可能出现 claude 命令找不到。');
    console.log('   你可以手动加入：export PATH="$HOME/.local/bin:$PATH"');
  }

  console.log('✅ 环境检查通过\n');
  return { ok: true, shell, inPath };
}

async function phase1InstallClaude(rl, dryRun = false) {
  console.log('[2/5] 安装 Claude Code');
  console.log('请选择 Claude Code 安装方式：');
  console.log('1. 官方推荐（curl 安装）');
  console.log('2. npm 安装（兼容模式 / 官方已弃用）');
  console.log('B. 返回并退出');

  while (true) {
    const choice = (await ask(rl, '请输入选项 [1/2/B]: ')).toUpperCase();
    if (choice === 'B') {
      return { ok: false, method: 'none', installPath: '(not installed)' };
    }

    if (choice === '1') {
      console.log('\n说明：官方 README 推荐 Linux 使用 curl 安装。');
      console.log(`即将执行：${OFFICIAL_INSTALL_CMD}`);
      const confirm = (await ask(rl, '确认执行？[Y/n]: ')).toLowerCase();
      if (confirm === 'n') continue;

      const res = run(OFFICIAL_INSTALL_CMD, dryRun);
      const installPath = spawnSync('bash', ['-lc', 'command -v claude || true'], { encoding: 'utf-8' }).stdout.trim() || '(unknown)';
      return { ok: res.status === 0, method: 'official-curl', installPath };
    }

    if (choice === '2') {
      console.log('\n说明：npm 安装是兼容链路，官方已标注 deprecated。');
      console.log(`即将执行：${NPM_INSTALL_CMD}`);
      const confirm = (await ask(rl, '确认执行？[Y/n]: ')).toLowerCase();
      if (confirm === 'n') continue;

      const res = run(NPM_INSTALL_CMD, dryRun);
      const installPath = spawnSync('bash', ['-lc', 'command -v claude || true'], { encoding: 'utf-8' }).stdout.trim() || '(unknown)';
      return { ok: res.status === 0, method: 'npm-deprecated', installPath };
    }

    console.log('无效输入，请重试。');
  }
}

async function phase2Config(rl) {
  console.log('\n[3/5] 配置 API / 代理（最小配置）');
  console.log('支持三种模式：');
  console.log('- 官方账户 / 官方登录模式');
  console.log('- Anthropic API 模式');
  console.log('- 兼容代理 / Router / 中转模式');
  console.log('');

  const mode = await ask(rl, '选择模式 [official/api/router] (默认 api): ') || 'api';
  const baseUrl = await ask(rl, 'Base URL (可空): ');
  const apiKey = await ask(rl, 'API Key (可空): ');
  const model = await ask(rl, 'Model (可空): ');

  const summary = {
    mode,
    baseUrl: baseUrl || '(empty)',
    apiKeyMasked: maskSecret(apiKey),
    model: model || '(empty)',
  };

  console.log('\n配置摘要：');
  console.log(`- mode: ${summary.mode}`);
  console.log(`- base_url: ${summary.baseUrl}`);
  console.log(`- api_key: ${summary.apiKeyMasked}`);
  console.log(`- model: ${summary.model}`);

  const save = (await ask(rl, '确认保存？[Y/n]: ')).toLowerCase();
  if (save === 'n') {
    return { ok: true, saved: false, path: '(not saved)', summary };
  }

  const target = (await ask(rl, '保存格式 [1=config.json, 2=.env.zcc, 3=both] (默认1): ')) || '1';
  const home = os.homedir();
  const zccDir = path.join(home, '.zcc');
  fs.mkdirSync(zccDir, { recursive: true });

  const config = {
    mode,
    base_url: baseUrl || '',
    api_key: apiKey || '',
    model: model || '',
    updated_at: new Date().toISOString(),
  };

  const written = [];
  if (target === '1' || target === '3') {
    const configPath = path.join(zccDir, 'config.json');
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    written.push(configPath);
  }
  if (target === '2' || target === '3') {
    const envPath = path.join(zccDir, '.env.zcc');
    const envText = [
      `ZCC_MODE=${mode}`,
      `ZCC_BASE_URL=${baseUrl}`,
      `ZCC_API_KEY=${apiKey}`,
      `ZCC_MODEL=${model}`,
    ].join('\n') + '\n';
    fs.writeFileSync(envPath, envText, 'utf-8');
    written.push(envPath);
  }

  return { ok: true, saved: true, path: written.join(', '), summary };
}

async function phase3RunPlugins(phase, context) {
  const title = phase === 4 ? '[4/5] Skills 导入插件接口' : '[5/5] 飞书初始化插件接口';
  console.log(`\n${title}`);
  const results = await runPhasePlugins(phase, context);
  results.forEach((r) => {
    const icon = r.status === 'ok' ? '✅' : r.status === 'failed' ? '❌' : '⏭️';
    console.log(`- ${icon} [${r.id}] ${r.message}`);
  });
  return results;
}

function summarizePluginResults(results = []) {
  if (!results || results.length === 0) return '未执行';
  if (results.some((r) => r.status === 'failed')) return '部分失败';
  if (results.some((r) => r.status === 'ok')) return '已执行';
  return '占位/已跳过';
}

function printFinalSummary({ envResult, installResult, configResult, phase4Results, phase5Results }) {
  console.log('\n════════════ 安装结果摘要 ════════════');
  console.log(`- Claude Code 安装方式: ${installResult.method}`);
  console.log(`- 当前安装位置: ${installResult.installPath}`);
  console.log(`- API 配置状态: ${configResult.saved ? '已保存' : '未保存'}`);
  console.log(`- API 配置文件: ${configResult.path}`);
  console.log(`- Skills 导入状态: ${summarizePluginResults(phase4Results)}`);
  console.log(`- 飞书初始化状态: ${summarizePluginResults(phase5Results)}`);
  console.log('');
  console.log('下一步建议：');
  console.log('1) 运行 `claude --version` 验证安装');
  console.log('2) 运行 `claude` 进入交互');
  if (!envResult.inPath) {
    console.log('3) 若 claude 不可用，先把 ~/.local/bin 加入 PATH');
  }
  console.log('══════════════════════════════════════');
}

async function runInstallFlow({ dryRun = false }) {
  banner();
  const rl = readline.createInterface({ input, output });
  try {
    const envResult = phase0EnvironmentCheck();
    if (!envResult.ok) {
      process.exitCode = 1;
      return;
    }

    const installResult = await phase1InstallClaude(rl, dryRun);
    if (!installResult.ok) {
      console.log('\n已取消安装流程。');
      process.exitCode = 1;
      return;
    }

    const configResult = await phase2Config(rl);

    const context = {
      dryRun,
      envResult,
      installResult,
      configResult,
      now: new Date().toISOString(),
    };
    const phase4Results = await phase3RunPlugins(4, context);
    const phase5Results = await phase3RunPlugins(5, context);

    printFinalSummary({ envResult, installResult, configResult, phase4Results, phase5Results });
  }
  finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dryRun = args.includes('--dry-run');

  if (!cmd) {
    banner();
    usage();
    return;
  }

  if (cmd === 'install') {
    await runInstallFlow({ dryRun });
    return;
  }

  if (cmd.toLowerCase() === 'q') return;

  console.log(`未知命令: ${cmd}`);
  console.log('可用命令: install');
  process.exitCode = 1;
}

main();
