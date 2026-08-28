import { TuGoRunError, type RunFailure } from '../api'

export type PresentedRunError = {
  state: 'cancelled' | 'timed_out' | 'failed'
  message: string
  failure?: RunFailure
}

const messageForCode = (code?: string) => {
  switch (code) {
    case 'MODEL_AUTHENTICATION_FAILED': return '模型服务认证失败。'
    case 'MODEL_PERMISSION_DENIED': return '当前凭据没有调用该模型的权限。'
    case 'MODEL_RATE_LIMITED': return '模型服务触发了请求频率限制。'
    case 'MODEL_TIMEOUT': return '模型服务响应超时。'
    case 'MODEL_NETWORK_UNAVAILABLE': return '无法连接模型服务。'
    case 'MODEL_SERVER_ERROR': return '模型服务暂时发生异常。'
    case 'MODEL_VISION_UNSUPPORTED': return '当前模型不支持图片输入。'
    case 'GATEWAY_VISION_UNSUPPORTED': return '当前模型网关不支持图片输入。'
    case 'IMAGE_INPUT_FORMAT_UNSUPPORTED': return '模型服务无法接受当前图片格式。'
    case 'CONTEXT_LIMIT_EXCEEDED': return '当前会话内容超过了模型上下文限制。'
    case 'CANVAS_UNAVAILABLE': return '画板窗口暂时不可用。'
    default: return ''
  }
}

const legacyMessage = (detail: string) => /current conversation has a running task|当前会话仍有运行中的任务/i.test(detail)
  ? '上一项操作仍在收尾，请稍后重试。'
  : /Error invoking remote method|tugo:runtime:request/i.test(detail)
    ? '应用内运行服务暂时不可用，请稍后重试。'
    : /tool_calls.*must be followed by tool messages/i.test(detail)
      ? '本次操作的上下文出现异常，已停止；请重新发送这条指令。'
      : `运行失败：${detail}`

export const presentRunError = (error: unknown, signal: AbortSignal): PresentedRunError => {
  const interrupted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
  if (interrupted) return signal.reason === 'timeout'
    ? { state: 'timed_out', message: 'AI 长时间没有响应，已自动停止本次操作。' }
    : { state: 'cancelled', message: '已取消本次 AI 操作。' }
  const failure = error instanceof TuGoRunError ? error.failure : undefined
  const detail = failure?.technical_detail || (error instanceof Error ? error.message : String(error))
  const reason = failure?.user_message || messageForCode(failure?.error_code) || failure?.message || ''
  const action = failure?.user_action || ''
  return {
    state: 'failed',
    message: reason ? (action && action !== reason ? `${reason}\n\n${action}` : reason) : (action || legacyMessage(detail)),
    ...(failure ? { failure } : {}),
  }
}
