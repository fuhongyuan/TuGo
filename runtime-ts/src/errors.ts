import type { JsonObject, ProviderErrorCategory } from './contracts.js'

export type ProviderErrorDetail = {
  status?: number
  category?: ProviderErrorCategory
  body?: string
  requestId?: string
}

export type RuntimeFailure = {
  error_code: string
  phase: string
  category: string
  retryable: boolean
  user_message: string
  user_action: string
  technical_detail: string
  status?: number
  retryAfterMs?: number
  provider_error?: ProviderErrorDetail
  disableVision?: boolean
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly category: ProviderErrorCategory = 'unknown',
    readonly providerDetail?: ProviderErrorDetail,
  ) {
    super(message)
    this.name = 'ModelProviderError'
  }
}

export class RuntimeFailureError extends Error {
  constructor(readonly failure: RuntimeFailure, readonly original?: unknown) {
    super(failure.technical_detail)
    this.name = 'RuntimeFailureError'
  }
}

export const providerCategoryForStatus = (status?: number): ProviderErrorCategory => status === 401 ? 'authentication'
  : status === 403 ? 'permission'
    : status === 408 ? 'timeout'
      : status === 429 ? 'rate_limit'
        : status === 400 || status === 404 || status === 409 || status === 422 ? 'validation'
          : status && status >= 500 ? 'server' : 'unknown'

const visionFailureKind = (detail: string): 'model' | 'gateway' | 'format' | undefined => {
  if (/only supports? text input|(?:the |this |current )?model[^.\n]{0,160}(?:does not|doesn't|cannot|can't)[^.\n]{0,80}(?:support|accept)[^.\n]{0,80}(?:images?|vision)|(?:images?|vision)[^.\n]{0,80}(?:not supported|unsupported)[^.\n]{0,80}(?:by|for) (?:the |this )?model/i.test(detail)) return 'model'
  if (/(?:gateway|proxy|channel|route|endpoint)[^.\n]{0,160}(?:does not|doesn't|cannot|can't)[^.\n]{0,80}(?:support|accept)[^.\n]{0,80}(?:images?|vision|multimodal)/i.test(detail)) return 'gateway'
  if (/unsupported content type ['"]?(?:image_url|image)|invalid[^.\n]{0,80}image_url|(?:base64|data:?\s*url)[^.\n]{0,100}(?:not supported|unsupported|invalid)/i.test(detail)) return 'format'
  return undefined
}

const copyFor = (code: string): { message: string; action: string } => {
  switch (code) {
    case 'MODEL_NOT_CONFIGURED': return { message: '尚未配置可用模型。', action: '请先在模型设置中连接并启用一个模型。' }
    case 'MODEL_DISABLED': return { message: '当前模型已被停用。', action: '请在模型设置中启用该模型，或切换到其它模型。' }
    case 'MODEL_CONFIGURATION_INVALID': return { message: '当前模型配置无效。', action: '请检查上下文长度、最大输出长度和服务地址。' }
    case 'MODEL_VISION_DISABLED': return { message: '当前模型的图片理解能力已关闭。', action: '请在模型设置中重新开启“支持视觉”，或切换视觉模型。' }
    case 'MODEL_AUTHENTICATION_FAILED': return { message: '模型服务认证失败。', action: '请检查当前模型的 API Key 和服务地址后重试。' }
    case 'MODEL_PERMISSION_DENIED': return { message: '当前凭据没有调用该模型的权限。', action: '请检查模型授权或账号套餐。' }
    case 'MODEL_RATE_LIMITED': return { message: '模型服务触发了请求频率限制。', action: '请稍后重试。' }
    case 'MODEL_TIMEOUT': return { message: '模型服务响应超时。', action: '请稍后重试，或缩短请求内容。' }
    case 'MODEL_NETWORK_UNAVAILABLE': return { message: '无法连接模型服务。', action: '请检查网络、服务地址和中转服务状态。' }
    case 'MODEL_SERVER_ERROR': return { message: '模型服务暂时发生异常。', action: '请稍后重试。' }
    case 'MODEL_RESPONSE_INVALID': return { message: '模型返回的数据格式不完整。', action: '系统将自动重试；若持续发生请检查模型兼容性。' }
    case 'MODEL_REQUEST_INVALID': return { message: '模型服务拒绝了本次请求。', action: '请检查模型名称、请求参数和服务接口兼容性。' }
    case 'MODEL_VISION_UNSUPPORTED': return { message: '当前模型明确不支持图片输入，已关闭该模型的视觉能力。', action: '请更换视觉模型后重试。' }
    case 'GATEWAY_VISION_UNSUPPORTED': return { message: '当前模型网关不支持图片输入。', action: '请检查中转渠道，或改用支持多模态的接口。' }
    case 'IMAGE_INPUT_FORMAT_UNSUPPORTED': return { message: '模型服务无法接受当前图片输入格式。', action: '请检查网关是否支持 image_url 和 Base64 图片。' }
    case 'CONTEXT_LIMIT_EXCEEDED': return { message: '当前会话内容超过了模型上下文限制。', action: '请减少附件或新建会话后重试。' }
    case 'TOOL_ARGUMENT_INVALID': return { message: '当前操作参数不完整或不符合工具要求。', action: '系统将尝试调整后重试。' }
    case 'TOOL_EXECUTION_FAILED': return { message: '画板操作未能执行完成。', action: '请根据提示调整请求后重试。' }
    case 'CANVAS_UNAVAILABLE': return { message: '画板窗口暂时不可用。', action: '请重新打开应用后重试。' }
    default: return { message: '运行服务未能完成本次操作。', action: '请修改请求后重试；需要技术信息时，可点击下方“查看失败详情”。' }
  }
}

export const normalizeRuntimeError = (
  error: unknown,
  phase = 'runtime',
  context: { hasImageAttachments?: boolean } = {},
): RuntimeFailure => {
  if (error instanceof RuntimeFailureError) return error.failure
  const technicalDetail = error instanceof Error ? error.message : String(error)
  const provider = error instanceof ModelProviderError ? error : undefined
  const status = provider?.status || Number(technicalDetail.match(/Model API (\d{3})/)?.[1] || 0) || undefined
  const category = provider?.category || (status ? providerCategoryForStatus(status) : error instanceof TypeError ? 'network' : 'unknown')
  const vision = context.hasImageAttachments ? visionFailureKind(technicalDetail) : undefined
  let code = /TuGo 尚未配置可用模型/i.test(technicalDetail) ? 'MODEL_NOT_CONFIGURED'
    : /当前模型已停用/i.test(technicalDetail) ? 'MODEL_DISABLED'
      : /当前模型未启用图片理解能力/i.test(technicalDetail) ? 'MODEL_VISION_DISABLED'
        : /模型 Context Window 配置无效|模型最大输出必须/i.test(technicalDetail) ? 'MODEL_CONFIGURATION_INVALID'
    : vision === 'model' ? 'MODEL_VISION_UNSUPPORTED'
    : vision === 'gateway' ? 'GATEWAY_VISION_UNSUPPORTED'
      : vision === 'format' ? 'IMAGE_INPUT_FORMAT_UNSUPPORTED'
        : category === 'authentication' ? 'MODEL_AUTHENTICATION_FAILED'
          : category === 'permission' ? 'MODEL_PERMISSION_DENIED'
            : category === 'rate_limit' ? 'MODEL_RATE_LIMITED'
              : category === 'timeout' ? 'MODEL_TIMEOUT'
                : category === 'network' ? 'MODEL_NETWORK_UNAVAILABLE'
                  : category === 'server' ? 'MODEL_SERVER_ERROR'
                    : category === 'malformed_response' ? 'MODEL_RESPONSE_INVALID'
                      : category === 'validation' ? (phase === 'tool' ? 'TOOL_ARGUMENT_INVALID' : 'MODEL_REQUEST_INVALID')
                      : /Context Window|context length|context window/i.test(technicalDetail) ? 'CONTEXT_LIMIT_EXCEEDED'
                        : /参数不合法|必须传入|validation|Invalid tool arguments/i.test(technicalDetail) ? 'TOOL_ARGUMENT_INVALID'
                          : /窗口不可用|Renderer/i.test(technicalDetail) ? 'CANVAS_UNAVAILABLE'
                            : 'RUNTIME_FAILED'
  if (phase === 'tool' && code === 'RUNTIME_FAILED') code = 'TOOL_EXECUTION_FAILED'
  const retryable = category === 'malformed_response'
    || status === 408 || status === 409 || status === 429 || Boolean(status && status >= 500)
    || error instanceof TypeError
    || /ECONNRESET|ETIMEDOUT|fetch failed|network|Unexpected token.*JSON|unterminated JSON/i.test(technicalDetail)
  const copy = copyFor(code)
  return {
    error_code: code,
    phase,
    category,
    retryable,
    user_message: copy.message,
    user_action: copy.action,
    technical_detail: technicalDetail,
    ...(status ? { status } : {}),
    ...(provider?.retryAfterMs !== undefined ? { retryAfterMs: provider.retryAfterMs } : {}),
    ...(provider?.providerDetail ? { provider_error: provider.providerDetail } : {}),
    ...(vision === 'model' ? { disableVision: true } : {}),
  }
}

export const runtimeFailurePayload = (failure: RuntimeFailure): JsonObject => ({
  error_code: failure.error_code,
  phase: failure.phase,
  error_category: failure.category,
  retryable: failure.retryable,
  user_message: failure.user_message,
  user_action: failure.user_action,
  technical_detail: failure.technical_detail,
  ...(failure.status ? { status: failure.status } : {}),
  ...(failure.provider_error ? { provider_error: failure.provider_error as unknown as JsonObject } : {}),
})
