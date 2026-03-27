#!/usr/bin/env bun
/**
 * Gemini MCP Server — bridges Claude Code to Google Gemini CLI
 * for multimodal tasks (vision, summarization, code analysis).
 *
 * Calls `gemini` CLI under the hood with --approval-mode yolo.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { spawn } from 'child_process'
import { dirname, resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { platform, homedir } from 'os'

const DEFAULT_MODEL = 'gemini-3-flash-preview'
const GEMINI_PATH = process.env.GEMINI_PATH ?? 'gemini'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_LANGUAGE = process.env.GEMINI_LANGUAGE ?? 'en'
const IS_WIN = platform() === 'win32'

// Ensure system binaries are findable (macOS/Linux)
if (!IS_WIN && !process.env.PATH?.includes('/usr/sbin')) {
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

/** Run gemini CLI and return stdout */
async function runGemini(prompt: string, model: string, timeoutMs?: number, includeDirs?: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['--approval-mode', 'yolo', '-p', prompt, `--model=${model}`]
    if (includeDirs?.length) {
      for (const dir of includeDirs) args.push('--include-directories', dir)
    }
    const proc = spawn(GEMINI_PATH, args, {
      cwd: IS_WIN ? homedir() : '/',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', code => {
      if (code === 0) {
        // Strip YOLO mode warnings from output
        const cleaned = stdout
          .split('\n')
          .filter(line => !line.includes('YOLO mode is enabled'))
          .filter(line => !line.includes('Loaded cached credentials'))
          .join('\n')
          .trim()
        resolve(cleaned)
      } else {
        reject(new Error(`gemini exited with code ${code}: ${stderr || stdout}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn gemini: ${err.message}`))
    })
  })
}

// ── MCP Server ──────────────────────────────────────────────

const mcp = new Server(
  { name: 'gemini', version: '1.0.0' },
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
  const model = DEFAULT_MODEL
  const timeoutMs = args.timeout ? (args.timeout as number) * 1000 : undefined
  const lang = langPrefix(args.language as string | undefined)

  try {
    switch (req.params.name) {
      case 'gemini_prompt': {
        const prompt = args.prompt as string
        if (!prompt) throw new Error('prompt is required')
        const result = await runGemini(`${lang}${prompt}`, model, timeoutMs)
        return { content: [{ type: 'text', text: result }] }
      }

      case 'gemini_vision': {
        const filePath = args.file_path as string
        if (!filePath) throw new Error('file_path is required')
        if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)

        const question =
          (args.question as string) ?? 'Describe this image in detail'
        const prompt = `${lang}Look at the image file at "${filePath}" and answer: ${question}`
        const result = await runGemini(prompt, model, timeoutMs, [dirname(filePath)])
        return { content: [{ type: 'text', text: result }] }
      }

      case 'gemini_code': {
        const instruction = args.instruction as string
        if (!instruction) throw new Error('instruction is required')

        let codeContent = args.code as string | undefined
        const filePath = args.file_path as string | undefined
        const dirs: string[] = []

        if (filePath) {
          if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
          codeContent = readFileSync(filePath, 'utf8')
          dirs.push(dirname(filePath))
        }

        if (!codeContent) throw new Error('Either code or file_path is required')

        const prompt = `${lang}${instruction}\n\n\`\`\`\n${codeContent}\n\`\`\``
        const result = await runGemini(prompt, model, timeoutMs, dirs.length ? dirs : undefined)
        return { content: [{ type: 'text', text: result }] }
      }

      case 'gemini_summarize': {
        let text = args.text as string | undefined
        const filePath = args.file_path as string | undefined
        const style = (args.style as string) ?? 'bullets'
        const dirs: string[] = []

        if (filePath) {
          if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
          text = readFileSync(filePath, 'utf8')
          dirs.push(dirname(filePath))
        }

        if (!text) throw new Error('Either text or file_path is required')

        const styleInstructions: Record<string, string> = {
          brief: 'Summarize in 1-2 sentences.',
          detailed: 'Provide a detailed paragraph summary.',
          bullets: 'Summarize as concise bullet points.',
        }

        const prompt = `${lang}${styleInstructions[style] ?? styleInstructions.bullets}\n\n${text}`
        const result = await runGemini(prompt, model, timeoutMs, dirs.length ? dirs : undefined)
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
