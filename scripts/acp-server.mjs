#!/usr/bin/env node

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.AGENTHOME_ACP_PORT || '8787')
const HOST = process.env.AGENTHOME_ACP_HOST || '127.0.0.1'

/**
 * sessionId -> {
 *   id, taskId, command, cwd, initialInput, events, stopped, running, history
 * }
 */
const sessions = new Map()

function json(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('payload too large'))
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json body'))
      }
    })
    req.on('error', reject)
  })
}

function pushEvent(session, event) {
  session.events.push(event)
  // Keep memory bounded.
  if (session.events.length > 5000) {
    session.events.splice(0, session.events.length - 5000)
  }
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function buildPromptWithHistory(session, input) {
  const historyText = session.history
    .map((item, idx) => `${idx + 1}. 用户: ${item.user}\n   助手: ${item.assistant || '(无输出)'}`)
    .join('\n')
  if (!historyText) return input
  return [
    '以下是会话历史，请保持上下文连续：',
    historyText,
    '',
    `本轮用户输入：${input}`,
    '请继续回复。'
  ].join('\n')
}

function runTurn(session, rawInput) {
  if (session.stopped) return
  if (session.running) return
  const input = String(rawInput || '').trim()
  if (!input) {
    pushEvent(session, { type: 'needs_input' })
    return
  }
  session.running = true
  pushEvent(session, { type: 'stdout', data: `[acp] input received (${Buffer.byteLength(input)} bytes)\n` })

  const prompt = buildPromptWithHistory(session, input)
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'zsh'
  const shellArgs = process.platform === 'win32'
    ? ['-Command', `${session.command} ${shellSingleQuote(prompt)}`]
    : ['-c', `${session.command} ${shellSingleQuote(prompt)}`]

  const child = spawn(shell, shellArgs, {
    cwd: session.cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  pushEvent(session, { type: 'stdout', data: `[acp] turn started\n` })

  child.stdout.on('data', (buf) => {
    const data = buf.toString()
    stdout += data
    pushEvent(session, { type: 'stdout', data })
  })

  child.stderr.on('data', (buf) => {
    const data = buf.toString()
    stderr += data
    pushEvent(session, { type: 'stdout', data })
  })

  child.on('error', (error) => {
    pushEvent(session, { type: 'error', message: error.message || 'child process error' })
    session.running = false
    if (!session.stopped) pushEvent(session, { type: 'needs_input' })
  })

  child.on('close', (code) => {
    session.running = false
    session.history.push({
      user: input,
      assistant: stdout.trim() || stderr.trim() || ''
    })
    if (session.history.length > 20) {
      session.history.splice(0, session.history.length - 20)
    }
    if ((code ?? 0) !== 0) {
      pushEvent(session, { type: 'error', message: `turn exited with code ${code ?? -1}` })
    }
    if (!session.stopped) {
      pushEvent(session, { type: 'needs_input' })
    }
  })
}

function createSession({ taskId, command, cwd, initialInput }) {
  if (!command || typeof command !== 'string') {
    throw new Error('command is required')
  }

  const id = randomUUID()
  const session = {
    id,
    taskId: taskId || id,
    command,
    cwd: typeof cwd === 'string' && cwd ? cwd : process.cwd(),
    initialInput: typeof initialInput === 'string' ? initialInput : '',
    events: [],
    stopped: false,
    running: false,
    history: []
  }
  sessions.set(id, session)
  pushEvent(session, { type: 'stdout', data: `[acp] session started: ${session.command}\n` })
  if (session.initialInput.trim()) {
    runTurn(session, session.initialInput)
  } else {
    pushEvent(session, { type: 'needs_input' })
  }
  return id
}

function getSessionFromPath(pathname) {
  const parts = pathname.split('/').filter(Boolean)
  // /sessions/:id/:action
  if (parts.length < 2 || parts[0] !== 'sessions') return null
  const sessionId = parts[1]
  const action = parts[2] || ''
  const session = sessions.get(sessionId)
  if (!session) return null
  return { session, action }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
  const { pathname, searchParams } = url

  if (req.method === 'GET' && pathname === '/healthz') {
    return json(res, 200, { ok: true })
  }

  if (req.method === 'POST' && pathname === '/sessions') {
    try {
      const body = await readJsonBody(req)
      const sessionId = createSession(body)
      return json(res, 200, { sessionId })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : 'failed to create session' })
    }
  }

  const parsed = getSessionFromPath(pathname)
  if (!parsed) {
    return json(res, 404, { error: 'not found' })
  }
  const { session, action } = parsed

  if (req.method === 'GET' && action === 'events') {
    const cursor = Number(searchParams.get('cursor') || '0')
    const nextCursor = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0
    const events = session.events.slice(nextCursor)
    return json(res, 200, {
      nextCursor: nextCursor + events.length,
      events
    })
  }

  if (req.method === 'POST' && action === 'input') {
    try {
      const body = await readJsonBody(req)
      const input = typeof body.input === 'string' ? body.input : ''
      if (session.stopped) {
        return json(res, 409, { error: 'session already stopped' })
      }
      if (session.running) {
        return json(res, 409, { error: 'session is busy' })
      }
      runTurn(session, input)
      return json(res, 200, { ok: true })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : 'invalid input body' })
    }
  }

  if (req.method === 'POST' && action === 'stop') {
    session.stopped = true
    pushEvent(session, { type: 'task_exit', exitCode: 0 })
    return json(res, 200, { ok: true })
  }

  return json(res, 405, { error: 'method not allowed' })
})

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[acp-server] listening at http://${HOST}:${PORT}`)
})

