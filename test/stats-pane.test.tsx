import { expect, test } from 'claude-code/testing'

test('command runs stats and pane shows its lines', async ($, on) => {
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: '📈 ADOPTION\n  sessions 22   active 3 (14%)\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'memory-stats', args: '' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-memory', surface, component: 'Pane', props: {}, requestId: 'memory-stats', viewport: { columns: 100, rows: 40 } })
    expect(await ui.find({ type: 'Text', text: /ADOPTION/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /sessions 22/ })).toBeDefined()
    await ui.unmount()
  }
})
