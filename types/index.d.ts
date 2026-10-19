declare module 'claude-code' {
  interface PluginState {
    'agent-memory': { statsOutput: string }
  }
}

export type AgentMemoryStatsOutput = string
