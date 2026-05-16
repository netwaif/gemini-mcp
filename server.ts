#!/usr/bin/env bun
/**
 * Gemini MCP Server — bridges Claude Code to Google Gemini CLI
 * for multimodal tasks (vision, summarization, code analysis).
 *
 * Calls `gemini` CLI in read-only ("plan") approval mode with JSON output.
 * Large inputs and files are passed via stdin / `@path` references, never
 * embedded in argv (avoids ARG_MAX). See README for the design rationale.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { spawn } from 'child_process'
import { dirname } from 'path'
import { existsSync } from 'fs'
import { platform, tmpdir } from 'os'

const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview'
const GEMINI_PATH = process.env.GEMINI_PATH ?? 'gemini'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_LANGUAGE = process.env.GEMINI_LANGUAGE ?? 'ko'
const IS_WIN = platform() === 'win32'

// Ensure system binaries are findable (macOS/Linux)
if (!IS_WIN && process.env.PATH && !process.env.PATH.includes('/usr/sbin')) {
  process.env.PATH = `/usr/sbin:/usr/bin:/sbin:/bin:${process.env.PATH}`
}

process.on('unhandledRejection', err => {
  process.stderr.write(`gemini-mcp: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`gemini-mcp: uncaught exception: ${err}\n`)
})

/** Build language instruction prefix */
function langPrefix(lang?: string): string {
  const l = lang ?? DEFAULT_LANGUAGE
  if (!l || l === 'none') return ''
  const langMap: Record<string, string> = {
    ko: '한국어로 답변해주세요.\n\n',
    en: 'Please respond in English.\n\n',
    ja: '日本語で回答してください。\n\n',
    zh: '请用中文回答。\n\n',
  }
  return langMap[l] ?? `Please respond in ${l}.\n\n`
}

/** Strip ANSI escape sequences (fallback path only). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '')
}

/**
 * Extract Gemini's answer from `--output-format json` stdout.
 * Falls back to line-cleaned plain text if JSON parsing fails.
 */
function parseGeminiOutput(stdout: string): string {
  const trimmed = stdout.trim()
  try {
    const obj = JSON.parse(trimmed)
    // gemini may exit 0 yet return a structured error — surface it as an error.
    if (obj?.error != null) {
      const e = obj.error
      throw new Error(typeof e === 'string' ? e : JSON.stringify(e))
    }
    const text =
      obj?.response ?? obj?.text ?? obj?.output ?? obj?.content ?? null
    if (typeof text === 'string') return text.trim()
    if (text != null) return JSON.stringify(text)
    // Parsed but unknown shape — return the whole object as a last resort.
    return JSON.stringify(obj)
  } catch (e) {
    // Re-throw our own structured-error signal; only the JSON.parse failure
    // path should fall through to plain-text cleanup.
    if (e instanceof Error && !(e instanceof SyntaxError)) throw e
    return fallbackClean(trimmed)
  }
}

/** Plain-text cleanup for non-JSON (older CLI / partial) output. */
function fallbackClean(trimmed: string): string {
  return stripAnsi(trimmed)
    .split('\n')
    .filter(line => !line.includes('YOLO mode is enabled'))
    .filter(line => !line.includes('Loaded cached credentials'))
    .join('\n')
    .trim()
}

/**
 * Escape a path for use in a gemini `@<path>` reference. The CLI's @-parser
 * delimits on whitespace and shell-ish punctuation, so backslash-escape the
 * characters that would otherwise truncate the path (common on macOS).
 */
function atRef(p: string): string {
  return '@' + p.replace(/[\s()[\]{}'"`\\]/g, '\\$&')
}

interface RunOpts {
  model: string
  timeoutMs?: number
  /** Directories the CLI is allowed to read (for @file references). */
  includeDirs?: string[]
  /** Large content piped via stdin instead of argv (avoids ARG_MAX). */
  stdinContent?: string
}

/** Run gemini CLI (read-only mode, JSON output) and return its answer. */
async function runGemini(prompt: string, opts: RunOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '--prompt', prompt,
      '--model', opts.model,
      // Read-only: never auto-approves shell/write tools (was: yolo).
      '--approval-mode', 'plan',
      // Required for headless/automated runs regardless of cwd trust.
      '--skip-trust',
      '--output-format', 'json',
    ]
    if (opts.includeDirs?.length) {
      for (const dir of opts.includeDirs) {
        args.push('--include-directories', dir)
      }
    }

    // cwd: a controlled directory, never filesystem root. Prefer the
    // target file's directory (so @file reads resolve), else a temp dir.
    const cwd = opts.includeDirs?.[0] ?? tmpdir()
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const proc = spawn(GEMINI_PATH, args, {
      cwd,
      env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      stdio: [opts.stdinContent != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // Own process group so we can kill gemini AND its children. Without
      // this, gemini's child (e.g. an API retry loop) survives proc.kill,
      // keeps stdout open, and 'close' never fires -> timeout never returns.
      detached: !IS_WIN,
    })

    /** Kill the whole process group (gemini + children), with fallback. */
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (!IS_WIN && proc.pid) process.kill(-proc.pid, sig)
        else proc.kill(sig)
      } catch {
        try { proc.kill(sig) } catch { /* already gone */ }
      }
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    let escalateTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      killTree('SIGTERM')
      // Escalate if it ignores SIGTERM — but never after the process is
      // gone (settled), so we can't SIGKILL a recycled process-group id.
      escalateTimer = setTimeout(() => {
        if (!settled) killTree('SIGKILL')
      }, 2_000)
      escalateTimer.unref?.()
    }, timeoutMs)

    const clearTimers = (): void => {
      clearTimeout(timer)
      if (escalateTimer) clearTimeout(escalateTimer)
    }

    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })

    proc.on('close', code => {
      if (settled) return
      settled = true
      clearTimers()
      if (timedOut) {
        reject(new Error(
          `gemini timed out after ${Math.round(timeoutMs / 1000)}s` +
          (stderr ? `: ${stderr.trim().slice(-500)}` : ''),
        ))
      } else if (code === 0) {
        resolve(parseGeminiOutput(stdout))
      } else {
        reject(new Error(
          `gemini exited with code ${code}: ${(stderr || stdout).trim().slice(-800)}`,
        ))
      }
    })

    proc.on('error', err => {
      if (settled) return
      settled = true
      clearTimers()
      reject(new Error(`Failed to spawn gemini: ${err.message}`))
    })

    if (opts.stdinContent != null) {
      proc.stdin.on('error', () => {}) // ignore EPIPE if proc dies early
      proc.stdin.end(opts.stdinContent)
    }
  })
}

// ── MCP Server ──────────────────────────────────────────────

const mcp = new Server(
  { name: 'gemini', version: '1.1.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Gemini bridge for multimodal and vision tasks.',
      'Use gemini_vision when you need to analyze images — Claude is weaker at this.',
      'Use gemini_prompt for general Gemini queries or when a second opinion is useful.',
      'Use gemini_code for delegating code review or analysis to Gemini.',
      'Use gemini_summarize for summarizing long text that might benefit from Gemini\'s approach.',
      '',
      'When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.',
    ].join('\n'),
  },
)

// Common optional params shared across all tools
const commonParams = {
  model: {
    type: 'string',
    description: `Gemini model to use (default: "${DEFAULT_MODEL}"). Override per-call if needed.`,
  },
  timeout: {
    type: 'number',
    description: `Timeout in seconds (default: ${DEFAULT_TIMEOUT_MS / 1000}). Increase for complex tasks.`,
  },
  language: {
    type: 'string',
    description: `Response language: "ko" (Korean, default), "en", "ja", "zh", or any language name. Use "none" to skip.`,
  },
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'gemini_prompt',
      description:
        'Send a text prompt to Gemini and get a response. Use for general questions, second opinions, or tasks where Gemini might excel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          prompt: { type: 'string', description: 'The prompt to send to Gemini' },
          ...commonParams,
        },
        required: ['prompt'],
      },
    },
    {
      name: 'gemini_vision',
      description:
        'Analyze an image file using Gemini\'s multimodal capabilities. Pass a file path and an optional question about the image. This is the primary reason this bridge exists — use it when image understanding is needed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the image file to analyze',
          },
          question: {
            type: 'string',
            description:
              'What to ask about the image (default: "Describe this image in detail")',
          },
          ...commonParams,
        },
        required: ['file_path'],
      },
    },
    {
      name: 'gemini_code',
      description:
        'Delegate code review or analysis to Gemini. Pass code content or a file path for Gemini to analyze.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          code: {
            type: 'string',
            description: 'Code content to analyze (provide this OR file_path)',
          },
          file_path: {
            type: 'string',
            description: 'Path to the code file to analyze (provide this OR code)',
          },
          instruction: {
            type: 'string',
            description:
              'What to do with the code (e.g., "review for bugs", "explain this function", "suggest improvements")',
          },
          ...commonParams,
        },
        required: ['instruction'],
      },
    },
    {
      name: 'gemini_summarize',
      description:
        'Summarize long text using Gemini. Useful for large documents, logs, or content that benefits from a fresh perspective.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string',
            description: 'Text to summarize (provide this OR file_path)',
          },
          file_path: {
            type: 'string',
            description: 'Path to the file to summarize (provide this OR text)',
          },
          style: {
            type: 'string',
            description:
              'Summary style: "brief" (1-2 sentences), "detailed" (paragraph), "bullets" (bullet points). Default: "bullets"',
          },
          ...commonParams,
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const model = (args.model as string) || DEFAULT_MODEL
  const timeoutMs = args.timeout ? (args.timeout as number) * 1000 : undefined
  const lang = langPrefix(args.language as string | undefined)

  try {
    switch (req.params.name) {
      case 'gemini_prompt': {
        const prompt = args.prompt as string
        if (!prompt) throw new Error('prompt is required')
        const full = `${lang}${prompt}`
        // Large prompts go via stdin to avoid ARG_MAX.
        const result = full.length > 65_536
          ? await runGemini(`${lang}Respond to the input provided above.`,
              { model, timeoutMs, stdinContent: prompt })
          : await runGemini(full, { model, timeoutMs })
        return { content: [{ type: 'text', text: result }] }
      }

      case 'gemini_vision': {
        const filePath = args.file_path as string
        if (!filePath) throw new Error('file_path is required')
        if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)

        const question =
          (args.question as string) ?? 'Describe this image in detail'
        // @path injects the image as multimodal input (CLI-side, read-only).
        const prompt = `${lang}${question}\n\n${atRef(filePath)}`
        const result = await runGemini(prompt, {
          model,
          timeoutMs,
          includeDirs: [dirname(filePath)],
        })
        return { content: [{ type: 'text', text: result }] }
      }

      case 'gemini_code': {
        const instruction = args.instruction as string
        if (!instruction) throw new Error('instruction is required')

        const inlineCode = args.code as string | undefined
        const filePath = args.file_path as string | undefined

        if (filePath) {
          if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
          // Reference the file directly — no readFileSync, no ARG_MAX risk.
          const prompt = `${lang}${instruction}\n\n${atRef(filePath)}`
          const result = await runGemini(prompt, {
            model,
            timeoutMs,
            includeDirs: [dirname(filePath)],
          })
          return { content: [{ type: 'text', text: result }] }
        }

        if (!inlineCode) throw new Error('Either code or file_path is required')
        // Inline code goes via stdin (appended before the -p prompt by the CLI).
        const result = await runGemini(
          `${lang}The code to analyze was provided as input above. ${instruction}`,
          { model, timeoutMs, stdinContent: inlineCode },
        )
        return { content: [{ type: 'text', text: result }] }
      }

      case 'gemini_summarize': {
        const inlineText = args.text as string | undefined
        const filePath = args.file_path as string | undefined
        const style = (args.style as string) ?? 'bullets'

        const styleInstructions: Record<string, string> = {
          brief: 'Summarize in 1-2 sentences.',
          detailed: 'Provide a detailed paragraph summary.',
          bullets: 'Summarize as concise bullet points.',
        }
        const instr = styleInstructions[style] ?? styleInstructions.bullets

        if (filePath) {
          if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
          const prompt = `${lang}${instr}\n\n${atRef(filePath)}`
          const result = await runGemini(prompt, {
            model,
            timeoutMs,
            includeDirs: [dirname(filePath)],
          })
          return { content: [{ type: 'text', text: result }] }
        }

        if (!inlineText) throw new Error('Either text or file_path is required')
        const result = await runGemini(
          `${lang}The text to summarize was provided as input above. ${instr}`,
          { model, timeoutMs, stdinContent: inlineText },
        )
        return { content: [{ type: 'text', text: result }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// ── Start ───────────────────────────────────────────────────

const transport = new StdioServerTransport()
await mcp.connect(transport)
process.stderr.write('gemini-mcp: server started\n')

function shutdown(): void {
  process.stderr.write('gemini-mcp: shutting down\n')
  process.exit(0)
}
process.stdin.on('end', shutdown)
process.on('SIGTERM', shutdown)
