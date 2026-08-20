import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('DeepSeek Harness Spike pins one official compatibility baseline', async () => {
  const lock = JSON.parse(await read('spikes/deepseek-harness/upstream-lock.json'))
  assert.equal(lock.commit, '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca')
  assert.equal(lock.version, '0.1.0-rc.7')
  assert.equal(lock.package, '@deepseek-ai/dsh@0.1.0-rc.7')
  assert.match(lock.node, /22\.19\.0/)
})

test('VibeHub Spike is an out-of-tree Bundle with a no-model-turn command', async () => {
  const manifest = JSON.parse(await read('spikes/deepseek-harness/bundle/package.json'))
  const [patch, plugin, client] = await Promise.all([
    read('spikes/deepseek-harness/bundle/cordis.patch.yml'),
    read('spikes/deepseek-harness/bundle/index.js'),
    read('spikes/deepseek-harness/bundle/client.js'),
  ])
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./package.json'], './package.json')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.match(patch, /dsh-vibehub-foundation-spike/)
  assert.match(plugin, /ctx\.commands\.register/)
  assert.match(plugin, /agent\.session\.append\('vibehub\/run'/)
  assert.match(plugin, /\{ ignorable: true \}/)
  assert.match(plugin, /sourceEventSeq: event\.seq/)
  assert.match(plugin, /name: 'vibehub-client-fixture'/)
  assert.match(plugin, /agent\.session\.append\('assistant\/message'/)
  assert.doesNotMatch(plugin, /agent\.prompt|agent\.send|llm/)
  for (const seam of [
    'conversation.chat.assistant-actions',
    'conversation.input.left',
    'conversation.view',
    'shell.overlay',
  ]) assert.match(client, new RegExp(seam.replaceAll('.', '\\.')))
  assert.match(client, /ctx\.sessions\.fork/)
  assert.match(client, /id: 'vibehub-graph'/)
  assert.match(client, /id: 'vibehub-run'/)
})

test('feasibility report keeps product truth and compatibility boundaries explicit', async () => {
  const report = await read('docs/DEEPSEEK_HARNESS_FEASIBILITY.md')
  for (const marker of [
    'Bundle/Profile distribution',
    'Whole product shell',
    'Session fork/resume identity',
    'Human command without model turn',
    'Existing Codex integration',
    'VibeHub-owned durable events',
    'Codex executor boundary',
    'Stop conditions',
  ]) assert.match(report, new RegExp(marker, 'i'))
  assert.match(report, /canonical Ticket, Context, Evidence, and Outcome files stay/)
  assert.match(report, /Do not route the primary product execution through the shipped one-shot/)
})
