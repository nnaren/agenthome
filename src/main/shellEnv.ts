import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** GUI 启动的 Electron 进程 PATH 往往不含 ~/.local/bin、nvm 等，需补齐后再 spawn CLI */
export function buildSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = base.HOME || homedir()
  const prepend: string[] = [
    join(home, '.local/bin'),
    join(home, '.npm-global/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  if (base.NVM_DIR) {
    prepend.unshift(join(base.NVM_DIR, 'current', 'bin'))
  }
  const seen = new Set<string>()
  const path = [...prepend, ...(base.PATH ?? '').split(':')]
    .filter((part) => part && !seen.has(part) && seen.add(part))
    .join(':')
  return {
    ...base,
    PATH: path,
    TERM: base.TERM ?? 'xterm-256color'
  }
}

export function shellInvoke(command: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: 'powershell.exe', args: ['-Command', command] }
  }
  return { shell: 'zsh', args: ['-l', '-c', command] }
}

export function resolveExecutableOnPath(binary: string, env: NodeJS.ProcessEnv = buildSpawnEnv()): string | null {
  try {
    const resolved = execSync(`command -v ${binary}`, {
      env,
      shell: '/bin/zsh',
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return resolved || null
  } catch {
    return null
  }
}

/** 将 `hermes acp ...` 解析为绝对路径，避免 Electron PATH 找不到命令 */
export function resolveCommandBinary(command: string, binary: string): string {
  const trimmed = command.trim()
  if (!trimmed.startsWith(`${binary} `) && trimmed !== binary) return trimmed
  const resolved = resolveExecutableOnPath(binary)
  if (!resolved) return trimmed
  if (trimmed === binary) return resolved
  return `${resolved}${trimmed.slice(binary.length)}`
}
