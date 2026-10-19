import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'memory-stats'
const output = atom({ plugin: 'agent-memory', key: 'statsOutput' } as const, '')

const refresh = async ($: EngineInterface) => {
  const r = await $.process.run(['node', `${$.plugin.root}/src/stats.ts`], {
    env: { NODE_USE_SYSTEM_CA: '0', OPENSSL_CONF: '/dev/null' },
  })
  await update($, output, () => (r.exitCode ? r.stderr : r.stdout).trimEnd())
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'memory-stats', description: 'Show agent-memory stats in a pane' })
    return next(e)
  })

  on('command.run', { command: 'memory-stats' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Memory stats' })
    return { text: 'Memory stats pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const lines = (await read($, output)).split('\n')
    return (
      <Box flexDirection="column">
        <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
        {lines.map(line =>
          /^\S/.test(line) ? (
            <Text mono weight="bold" color="cyan">{line}</Text>
          ) : (
            <Text mono>{line || ' '}</Text>
          ),
        )}
      </Box>
    )
  })
}
