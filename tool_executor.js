/**
 * Universal Tool Executor — Claude CLI 도구를 로컬에서 실행
 * z.ai, OpenAI 등 OpenAI-compatible API와 함께 사용
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RG_BIN = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/arm64-darwin/rg';

// ─────────────────────────────────────────
//  OpenAI Function Calling 도구 정의
// ─────────────────────────────────────────
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file. Returns content with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to file' },
          offset: { type: 'number', description: 'Start line (1-based)' },
          limit: { type: 'number', description: 'Max lines to read' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (creates or overwrites).',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace exact string in a file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path' },
          old_string: { type: 'string', description: 'Text to find' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command' },
          timeout: { type: 'number', description: 'Timeout in ms (default 120000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with regex (ripgrep).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern' },
          path: { type: 'string', description: 'Directory or file to search' },
          glob: { type: 'string', description: 'File glob filter (e.g. "*.py")' },
          output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode' },
          context: { type: 'number', description: 'Context lines around match' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_search',
      description: 'Find files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.py")' },
          path: { type: 'string', description: 'Base directory' },
        },
        required: ['pattern'],
      },
    },
  },
];

// ─────────────────────────────────────────
//  보안: 경로 검증
// ─────────────────────────────────────────
const BLOCKED_PATTERNS = [
  /\.env$/,
  /secrets\.json$/,
  /\.ssh\//,
  /\.gnupg\//,
  /\/etc\/shadow/,
  /\/etc\/passwd/,
];

function isPathSafe(filePath, workingDir) {
  // 절대 경로 변환
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workingDir, filePath);

  // 차단 패턴 검사
  for (const p of BLOCKED_PATTERNS) {
    if (p.test(resolved)) return false;
  }
  return true;
}

// ─────────────────────────────────────────
//  도구 실행기
// ─────────────────────────────────────────
function executeTool(name, args, workingDir) {
  try {
    switch (name) {
      case 'read_file': return execReadFile(args, workingDir);
      case 'write_file': return execWriteFile(args, workingDir);
      case 'edit_file': return execEditFile(args, workingDir);
      case 'bash': return execBash(args, workingDir);
      case 'grep': return execGrep(args, workingDir);
      case 'glob_search': return execGlob(args, workingDir);
      default: return `Error: Unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function execReadFile(args, workingDir) {
  const filePath = resolvePath(args.file_path, workingDir);
  if (!isPathSafe(filePath, workingDir)) return 'Error: Access denied';
  if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const offset = Math.max(0, (args.offset || 1) - 1);
  const limit = args.limit || 2000;
  const slice = lines.slice(offset, offset + limit);

  return slice.map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}`).join('\n');
}

function execWriteFile(args, workingDir) {
  const filePath = resolvePath(args.file_path, workingDir);
  if (!isPathSafe(filePath, workingDir)) return 'Error: Access denied';

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, args.content, 'utf-8');
  return `File written: ${filePath} (${args.content.length} bytes)`;
}

function execEditFile(args, workingDir) {
  const filePath = resolvePath(args.file_path, workingDir);
  if (!isPathSafe(filePath, workingDir)) return 'Error: Access denied';
  if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

  let content = fs.readFileSync(filePath, 'utf-8');
  if (!content.includes(args.old_string)) {
    return `Error: old_string not found in ${filePath}`;
  }

  if (args.replace_all) {
    content = content.split(args.old_string).join(args.new_string);
  } else {
    const idx = content.indexOf(args.old_string);
    content = content.substring(0, idx) + args.new_string + content.substring(idx + args.old_string.length);
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return `File edited: ${filePath}`;
}

function execBash(args, workingDir) {
  const timeout = Math.min(args.timeout || 120000, 300000); // max 5분
  const cmd = args.command;

  // 위험 명령 차단
  const dangerous = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=/, /:(){ :|:& };:/];
  for (const d of dangerous) {
    if (d.test(cmd)) return 'Error: Dangerous command blocked';
  }

  // 🛡️ 봇 프로세스 보호 — bot.js/planner.js를 죽이는 명령 차단
  const botKillPatterns = [
    /pkill\s+.*(?:bot\.js|planner\.js|node)/i,    // bot.js, planner.js, node 직접
    /pkill\s+-f\s+.*(?:bot|planner|discord)/i,     // -f 패턴에 bot/planner/discord 포함
    /kill\s+.*(?:bot\.js|planner\.js)/i,
    /killall\s+node/i,
    /kill\s+-9?\s*\$\(/i,                           // kill $(동적PID) 차단
    /launchctl\s+(?:stop|bootout|remove)/i,         // launchctl stop 전부 차단
  ];
  for (const p of botKillPatterns) {
    if (p.test(cmd)) {
      console.error(`🛡️ [tool_executor] 봇 프로세스 kill 명령 차단: ${cmd.slice(0, 80)}`);
      return 'Error: 봇 프로세스를 종료하는 명령은 차단되었습니다. canRestartBot 권한이 필요합니다.';
    }
  }

  try {
    const output = execSync(cmd, {
      cwd: workingDir,
      timeout,
      maxBuffer: 1024 * 1024 * 10, // 10MB
      encoding: 'utf-8',
      env: { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH}` },
    });
    return output || '(no output)';
  } catch (err) {
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';
    return `Exit code: ${err.status || 1}\n${stdout}\n${stderr}`.trim();
  }
}

function execGrep(args, workingDir) {
  const rgPath = fs.existsSync(RG_BIN) ? RG_BIN : 'rg';
  const searchPath = args.path ? resolvePath(args.path, workingDir) : workingDir;

  let rgArgs = [args.pattern, searchPath, '--no-heading', '-n'];

  if (args.output_mode === 'files_with_matches' || !args.output_mode) {
    rgArgs.push('-l');
  } else if (args.output_mode === 'count') {
    rgArgs.push('-c');
  }

  if (args.glob) rgArgs.push('--glob', args.glob);
  if (args.context) rgArgs.push('-C', String(args.context));

  // 결과 제한
  rgArgs.push('--max-count', '100');

  try {
    const output = execSync(`${rgPath} ${rgArgs.map(a => `'${a}'`).join(' ')}`, {
      cwd: workingDir,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5,
      encoding: 'utf-8',
    });
    return output || '(no matches)';
  } catch (err) {
    if (err.status === 1) return '(no matches)';
    return `Error: ${err.message}`;
  }
}

function execGlob(args, workingDir) {
  const basePath = args.path ? resolvePath(args.path, workingDir) : workingDir;
  const pattern = args.pattern;

  try {
    // fd가 있으면 사용, 없으면 find 폴백
    const output = execSync(
      `find "${basePath}" -path "*${pattern.replace(/\*\*/g, '*')}" -type f 2>/dev/null | head -50`,
      { cwd: workingDir, timeout: 15000, encoding: 'utf-8' }
    );
    return output || '(no matches)';
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function resolvePath(p, workingDir) {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(workingDir, p);
}

// ─────────────────────────────────────────
//  에이전트 도구 필터링
// ─────────────────────────────────────────

// Claude 도구명 → OpenAI function 이름 매핑
const TOOL_NAME_MAP = {
  'Read': 'read_file',
  'Write': 'write_file',
  'Edit': 'edit_file',
  'Bash': 'bash',
  'Grep': 'grep',
  'Glob': 'glob_search',
};

function getToolsForAgent(agent) {
  const allowed = new Set((agent.allowedTools || []).map(t => TOOL_NAME_MAP[t]).filter(Boolean));
  const disallowed = new Set((agent.disallowedTools || []).map(t => TOOL_NAME_MAP[t]).filter(Boolean));

  return TOOL_DEFINITIONS.filter(t => {
    const name = t.function.name;
    if (disallowed.has(name)) return false;
    if (allowed.size === 0) return true; // 제한 없으면 전체
    return allowed.has(name);
  });
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
  getToolsForAgent,
  isPathSafe,
};
