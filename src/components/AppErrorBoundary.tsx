import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

// A renderer exception must not become a blank desktop window. Reloading the
// renderer reconnects to durable state and never replays the failed UI action.
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }
  static getDerivedStateFromError(error: Error): State { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('TuGo renderer error', error, info.componentStack) }
  render() {
    if (!this.state.error) return this.props.children
    return <main className="app-error-boundary" role="alert"><section className="app-error-card"><span>恢复模式</span><h1>界面遇到了意外问题</h1><p>画板和会话数据已保存在本地。重新加载界面不会重新执行刚才的 AI 或画板操作。</p><button type="button" onClick={() => window.location.reload()}>重新加载界面</button></section></main>
  }
}
