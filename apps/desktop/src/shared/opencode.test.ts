import { describe, expect, it } from 'vitest'
import { applyEvent, type ChatItem, type OpenCodeEvent, toolLabel, toolOutput } from './opencode'

const run = (events: OpenCodeEvent[]) => events.reduce<ChatItem[]>(applyEvent, [])
const chunk = (sessionUpdate: string, text: string): OpenCodeEvent => ({ type: 'update', update: { sessionUpdate, content: { type: 'text', text } } as never })

describe('applyEvent', () => {
  it('joins message chunks and keeps thoughts apart', () => {
    const items = run([
      { type: 'prompt', text: 'Make a title card', at: 1 },
      chunk('agent_thought_chunk', 'Plan the '),
      chunk('agent_thought_chunk', 'shot.'),
      chunk('agent_message_chunk', 'On '),
      chunk('agent_message_chunk', 'it.'),
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'thought', 'agent'])
    expect(items[1]).toMatchObject({ text: 'Plan the shot.' })
    expect(items[2]).toMatchObject({ text: 'On it.' })
  })

  it('updates a tool call in place, keeping what the update leaves out', () => {
    const items = run([
      { type: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'uve_layer_create', kind: 'other', status: 'pending', rawInput: { type: 'text' } } },
      chunk('agent_message_chunk', 'Done soon.'),
      {
        type: 'update',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '{"id":"L1"}' } }] },
      },
    ])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: 'tool', title: 'uve_layer_create', status: 'completed', input: { type: 'text' }, output: '{"id":"L1"}' })
  })

  it('keeps one plan, updated in place', () => {
    const plan = (status: string): OpenCodeEvent => ({ type: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'Title', status }] } })
    const items = run([plan('pending'), chunk('agent_message_chunk', 'x'), plan('completed')])
    expect(items.filter((i) => i.kind === 'plan')).toHaveLength(1)
    expect(items[0]).toMatchObject({ entries: [{ status: 'completed' }] })
  })

  it('records permission questions and their answers', () => {
    const items = run([
      { type: 'permission', id: 'q1', toolCall: { toolCallId: 't2', title: 'bash', kind: 'execute', rawInput: { command: 'ls' } }, options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }] },
      { type: 'permission-done', id: 'q1', optionId: 'once' },
    ])
    expect(items[0]).toMatchObject({ kind: 'permission', title: 'bash', answer: 'once', done: true })
  })

  it('does not repeat the request OpenCode echoes, and clears on reset', () => {
    const items = run([{ type: 'prompt', text: 'Hi', at: 1 }, chunk('user_message_chunk', 'Hi')])
    expect(items).toHaveLength(1)
    expect(run([{ type: 'prompt', text: 'Hi', at: 1 }, { type: 'reset' }])).toEqual([])
  })
})

describe('toolOutput', () => {
  it('reads content, then raw output, and shortens long text', () => {
    expect(toolOutput({ content: [{ type: 'diff', path: 'a.txt', newText: 'x' }] })).toBe('Changed a.txt')
    expect(toolOutput({ rawOutput: { output: 'ok' } })).toBe('ok')
    expect(toolOutput({ rawOutput: { output: 'y'.repeat(5000) } }).length).toBeLessThan(4100)
  })

  it('names our tools without the server prefix', () => {
    expect(toolLabel('uve_layer_create')).toBe('layer_create')
    expect(toolLabel('read')).toBe('read')
  })
})
