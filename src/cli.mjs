import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const VERSION = '0.1.8';
const OFFICIAL_INSTALL_CMD = 'curl -fsSL https://claude.ai/install.sh | bash';
const NPM_INSTALL_CMD = 'npm install -g @anthropic-ai/claude-code';
const FEISHU_INSTALL_CMD = 'npx @larksuite/cli@latest install';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGED_SKILLS_ZIP = path.resolve(MODULE_DIR, '../assets/paper_skills_zip.zip');
const DEFAULT_CLOUD_SKILLS_DIR = path.join(process.cwd(), '.claude', 'skills');
const CLOUD_SKILLS_DIR = path.resolve(process.env.ZCC_CLOUD_SKILLS_DIR || DEFAULT_CLOUD_SKILLS_DIR);

/**
 * 插件接口
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removeDirIfExists(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function copyDirRecursive(srcDir, dstDir) {
  ensureDir(dstDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    }
    else {
      ensureDir(path.dirname(dst));
      fs.copyFileSync(src, dst);
    }
  }
}

function displayPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(process.cwd(), resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `.${path.sep}${relative}`;
  }
  if (!relative) {
    return '.';
  }
  return resolved;
}

function displayMaybePath(value) {
  if (!value || value.startsWith('(')) return value || '(empty)';
  return displayPath(value);
}

function listSkillDirs(rootDir) {
  const found = [];

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const hasSkill = entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md');
    if (hasSkill) {
      found.push(current);
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name));
      }
    }
  }

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }
  return found;
}

function findExtractedSkillsRoot(extractDir) {
  const directSkillsRoot = path.join(extractDir, 'skills');
  if (fs.existsSync(directSkillsRoot) && fs.statSync(directSkillsRoot).isDirectory()) {
    return directSkillsRoot;
  }

  const candidates = [];

  function walk(current, depth = 0) {
    if (depth > 3) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dir = path.join(current, entry.name);
      if (entry.name === 'skills') {
        candidates.push(dir);
        continue;
      }

      walk(dir, depth + 1);
    }
  }

  if (fs.existsSync(extractDir)) {
    walk(extractDir);
  }

  return candidates[0] || null;
}

function writeFeishuInitSkillFile(skillsRootDir) {
  const skillName = '飞书初始化';
  const skillDir = path.join(skillsRootDir, skillName);
  const skillPath = path.join(skillDir, 'SKILL.md');
  const skillPrompt = '帮我安装飞书 CLI：https://open.feishu.cn/document/no_class/mcp-archive/feishu-cli-installation-guide.md';
  const skillContent = [
    '---',
    `name: ${skillName}`,
    'version: 1.0.0',
    'description: 一键给出飞书 CLI 安装提示词。',
    '---',
    '',
    '# 飞书初始化',
    '',
    '## 提示词',
    skillPrompt,
    '',
    '## 用法',
    '在 cc 中直接发送上面的提示词即可。',
    '',
  ].join('\n');

  ensureDir(skillDir);
  fs.writeFileSync(skillPath, skillContent, 'utf-8');
  return { skillName, skillDir, skillPath, skillPrompt };
}

registerPhasePlugin(4, {
  id: 'skills-import-package',
  phase: 4,
  description: '解压包内技能包，并导入到当前项目的 .claude/skills 目录，同时追加“飞书初始化”技能提示词',
  run: async (context) => {
    const zccDir = path.join(os.homedir(), '.zcc');
    const skillsDir = CLOUD_SKILLS_DIR;
    const cacheDir = path.join(zccDir, 'cache');
    const extractDir = path.join(cacheDir, 'paper_skills_zip');
    const zipCandidates = [
      process.env.ZCC_SKILLS_ZIP,
      PACKAGED_SKILLS_ZIP,
    ].filter(Boolean);
    const zipPath = zipCandidates.find((candidate) => fs.existsSync(candidate));

    const dryZipPath = zipPath || zipCandidates[0] || '(unknown)';
    const dryMessage = `[dry-run] 将从 ${displayMaybePath(dryZipPath)} 解压技能包，导入到 ${displayPath(skillsDir)}，并写入“飞书初始化”技能文件。`;

    if (context?.dryRun) {
      return {
        status: 'skipped',
        message: dryMessage,
        details: {
          zip_path: zipPath,
          skills_dir: skillsDir,
          feishu_skill: path.join(skillsDir, '飞书初始化', 'SKILL.md'),
        },
      };
    }

    if (!zipPath) {
      return {
        status: 'failed',
        message: `未找到技能包。已尝试路径：${zipCandidates.map(displayMaybePath).join(' | ')}`,
      };
    }

    if (!commandExists('unzip')) {
      return {
        status: 'failed',
        message: '系统缺少 unzip 命令，无法解压技能包。',
      };
    }

    ensureDir(cacheDir);
    ensureDir(skillsDir);
    removeDirIfExists(extractDir);
    ensureDir(extractDir);

    const unzipRes = run(`unzip -o "${zipPath}" -d "${extractDir}"`, false);
    if (unzipRes.status !== 0) {
      return {
        status: 'failed',
        message: `解压失败（退出码 ${unzipRes.status}）。`,
      };
    }

    const extractedSkillsRoot = findExtractedSkillsRoot(extractDir);
    if (!extractedSkillsRoot) {
      return {
        status: 'failed',
        message: `解压结果中未找到 skills 目录：${displayPath(extractDir)}`,
      };
    }

    const sourceSkillDirs = listSkillDirs(extractedSkillsRoot);
    if (sourceSkillDirs.length === 0) {
      return {
        status: 'failed',
        message: `skills 目录中没有找到任何包含 SKILL.md 的技能目录：${displayPath(extractedSkillsRoot)}`,
      };
    }

    const importedSkillDirs = [];
    for (const sourceSkillDir of sourceSkillDirs) {
      const skillName = path.basename(sourceSkillDir);
      const targetSkillDir = path.join(skillsDir, skillName);
      removeDirIfExists(targetSkillDir);
      copyDirRecursive(sourceSkillDir, targetSkillDir);
      importedSkillDirs.push(targetSkillDir);
    }

    const feishu = writeFeishuInitSkillFile(skillsDir);

    return {
      status: 'ok',
      message: `技能包已导入到 ${displayPath(skillsDir)}：${importedSkillDirs.length} 个技能 + “${feishu.skillName}”。`,
      details: {
        zip_path: zipPath,
        source_skills_root: extractedSkillsRoot,
        imported_count: importedSkillDirs.length,
        imported_sample: importedSkillDirs.slice(0, 5),
        skills_dir: skillsDir,
        feishu_skill_path: feishu.skillPath,
      },
    };
  },
});

registerPhasePlugin(5, {
  id: 'feishu-bootstrap',
  phase: 5,
  description: '安装飞书 CLI，并提醒用户在 cc 使用“飞书初始化”提示词',
  run: async (context) => {
    const skillsDir = CLOUD_SKILLS_DIR;
    ensureDir(skillsDir);

    const feishu = writeFeishuInitSkillFile(skillsDir);

    if (context?.dryRun) {
      return {
        status: 'skipped',
        message: `[dry-run] 将在 ${displayPath(skillsDir)} 执行：${FEISHU_INSTALL_CMD}。`,
        details: {
          command: FEISHU_INSTALL_CMD,
          cwd: skillsDir,
          skill_name: feishu.skillName,
          skill_path: feishu.skillPath,
          prompt: feishu.skillPrompt,
        },
      };
    }

    const installRes = run(FEISHU_INSTALL_CMD, false, { cwd: skillsDir });
    if (installRes.status !== 0) {
      return {
        status: 'failed',
        message: `飞书 CLI 安装失败（退出码 ${installRes.status}）。`,
        details: {
          command: FEISHU_INSTALL_CMD,
          cwd: skillsDir,
          skill_path: feishu.skillPath,
        },
      };
    }

    return {
      status: 'ok',
      message: `飞书 CLI 已安装。请在 cc 输入“飞书初始化”（文件：${displayPath(feishu.skillPath)}）。`,
      details: {
        command: FEISHU_INSTALL_CMD,
        cwd: skillsDir,
        skill_name: feishu.skillName,
        skill_path: feishu.skillPath,
      },
    };
  },
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

function run(command, dryRun = false, options = {}) {
  if (dryRun) {
    if (options.cwd) {
      console.log(`🧪 [dry-run] (cd ${options.cwd} && ${command})`);
    }
    else {
      console.log(`🧪 [dry-run] ${command}`);
    }
    return { status: 0 };
  }

  const spawnOptions = {
    stdio: 'inherit',
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
  return spawnSync('bash', ['-lc', command], spawnOptions);
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

function isValidConfigName(name) {
  return /^[A-Za-z0-9 ._-]+$/.test(name);
}

function phase0EnvironmentCheck() {
  console.log('[1/5] 环境检查');
  const checks = [
    { name: 'bash', ok: commandExists('bash') },
    { name: 'curl', ok: commandExists('curl') },
    { name: 'git', ok: commandExists('git') },
    { name: 'node', ok: commandExists('node') },
    { name: 'npm', ok: commandExists('npm') },
    { name: 'unzip', ok: commandExists('unzip') },
  ];

  const isLinux = os.platform() === 'linux';
  const shell = process.env.SHELL || '(unknown)';
  const localBin = path.join(os.homedir(), '.local/bin');
  const inPath = (process.env.PATH || '').split(':').includes(localBin);

  console.log(`- OS: ${os.platform()} ${isLinux ? '✅' : '❌ (仅支持 Linux)'} `);
  checks.forEach((c) => console.log(`- ${c.name}: ${c.ok ? '✅' : '❌'}`));
  console.log(`- 当前 shell: ${shell}`);
  console.log(`- ~/.local/bin 在 PATH: ${inPath ? '✅' : '❌'}`);
  console.log(`- Skills 目录: ${displayPath(CLOUD_SKILLS_DIR)}`);

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
  console.log('示例：GLM CN / OpenRouter / Anthropic API');

  let profileName = await ask(rl, '配置名称（仅限字母、数字、空格、._-，默认 GLM CN）: ');
  if (!profileName) profileName = 'GLM CN';
  while (!isValidConfigName(profileName)) {
    profileName = await ask(rl, '名称不合法，请重新输入（仅限字母、数字、空格、._-）: ');
    if (!profileName) profileName = 'GLM CN';
  }

  console.log(`编辑配置：${profileName}`);
  const mode = await ask(rl, '选择模式 [official/api/router] (默认 api): ') || 'api';
  const baseUrl = await ask(rl, '请输入 API 基础 URL（默认 https://open.bigmodel.cn/api/anthropic）: ') || 'https://open.bigmodel.cn/api/anthropic';
  const apiKey = await ask(rl, '请输入 API 密钥（可空，建议后续手动填入 .env.zcc）: ');
  const model = await ask(rl, 'Model (可空): ');

  const summary = {
    profileName,
    mode,
    baseUrl: baseUrl || '(empty)',
    apiKeyMasked: maskSecret(apiKey),
    model: model || '(empty)',
  };

  console.log('\n配置摘要：');
  console.log(`- profile: ${summary.profileName}`);
  console.log(`- mode: ${summary.mode}`);
  console.log(`- base_url: ${summary.baseUrl}`);
  console.log(`- api_key: ${summary.apiKeyMasked}`);
  console.log(`- model: ${summary.model}`);

  const save = (await ask(rl, '确认保存？[Y/n]: ')).toLowerCase();
  if (save === 'n') {
    return { ok: true, saved: false, path: '(not saved)', summary };
  }

  const target = (await ask(rl, '保存格式 [1=config.json, 2=.env.zcc, 3=both] (默认1): ')) || '1';
  const zccDir = path.join(os.homedir(), '.zcc');
  ensureDir(zccDir);

  const config = {
    profile_name: profileName,
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
      '# ZCC API 配置（请手动填写 ZCC_API_KEY）',
      `ZCC_PROFILE_NAME=${profileName}`,
      `ZCC_MODE=${mode}`,
      `ZCC_BASE_URL=${baseUrl}`,
      'ZCC_API_KEY=',
      `ZCC_MODEL=${model}`,
    ].join('\n') + '\n';
    fs.writeFileSync(envPath, envText, 'utf-8');
    written.push(envPath);
  }

  return { ok: true, saved: true, path: written.join(', '), summary };
}

async function phase3RunPlugins(phase, context) {
  const title = phase === 4 ? '[4/5] Skills 导入' : '[5/5] 飞书初始化';
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
  console.log(`- Skills 目录: ${displayPath(CLOUD_SKILLS_DIR)}`);
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

async function runInteractiveMenu() {
  banner();
  usage();

  const rl = readline.createInterface({ input, output });
  try {
    const choice = (await ask(rl, '请输入选项 [1/Q]: ')).toUpperCase();
    if (choice === '1') {
      await runInstallFlow({ dryRun: false });
      return;
    }
    if (choice === 'Q' || choice === '') {
      return;
    }

    console.log(`未知选项: ${choice}`);
    console.log('请重新执行并输入 1 或 Q。');
    process.exitCode = 1;
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
    await runInteractiveMenu();
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
