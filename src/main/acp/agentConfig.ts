import type { AgentType } from '../../shared/types'
import { resolveCommandBinary } from '../shellEnv'

const ACP_ELIGIBLE_AGENTS = new Set<AgentType>(['claude-code', 'hermes-agent'])

function hermesAcpCommand(): string {
  const custom = process.env.AGENTHOME_ACP_HERMES_COMMAND?.trim()
  const base = custom || 'hermes acp --accept-hooks'
  return resolveCommandBinary(base, 'hermes')
}

function claudeAcpCommand(): string {
  const custom =
    process.env.AGENTHOME_ACP_AGENT_COMMAND?.trim()
    || process.env.AGENTHOME_ACP_CLAUDE_COMMAND?.trim()
  const base = custom || 'npx --yes @agentclientprotocol/claude-agent-acp@latest --acp'
  return resolveCommandBinary(base, 'npx')
}

export function isAcpEligibleAgent(agent: AgentType): boolean {
  return ACP_ELIGIBLE_AGENTS.has(agent)
}

/** hermes-agent 默认走 ACP；claude-code 需 AGENTHOME_ENABLE_ACP=1；设 AGENTHOME_ENABLE_ACP=0 可全局关闭 */
export function isAcpFeatureEnabled(agent: AgentType): boolean {
  if (process.env.AGENTHOME_ENABLE_ACP === '0') return false
  if (agent === 'hermes-agent') return true
  return process.env.AGENTHOME_ENABLE_ACP === '1'
}

export function isAcpRegistryAllowed(): boolean {
  return process.env.AGENTHOME_ENABLE_ACP !== '0'
}

export function getAcpAgentCommand(agent: AgentType): string {
  if (agent === 'hermes-agent') return hermesAcpCommand()
  if (agent === 'claude-code') return claudeAcpCommand()
  throw new Error(`agent ${agent} has no ACP command`)
}

/** Hermes 与 Claude 均通过 ACP session/resume + session/load 恢复；attach 时抑制历史重放避免与 UI chat 重复 */
