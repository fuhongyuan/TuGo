import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppErrorBoundary } from './AppErrorBoundary'

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('AppErrorBoundary', () => {
  it('replaces a renderer crash with a recoverable screen instead of a blank page', () => {
    const originalError = console.error
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const Crash = () => { throw new Error('test renderer crash') }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => root?.render(<AppErrorBoundary><Crash /></AppErrorBoundary>))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('界面遇到了意外问题')
    expect(container.querySelector('button')?.textContent).toBe('重新加载界面')
    expect(console.error).toHaveBeenCalled()
    // React reports the component error before the boundary's diagnostic log.
    expect(originalError).toBeTypeOf('function')
  })
})
