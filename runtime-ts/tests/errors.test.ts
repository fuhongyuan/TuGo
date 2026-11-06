import { describe, expect, it } from 'vitest'
import { ModelProviderError, normalizeRuntimeError, runtimeFailurePayload } from '../src/errors.js'
import {projectContext} from '../src/contextProjection.js'

describe('runtime error normalization', () => {
  it('reports local context admission separately from runtime/HTTP/provider failures',()=>{
    let failure
    try{projectContext({messages:[{role:'user',content:'x'.repeat(5000)}]},{contextWindow:4096})}catch(error){failure=normalizeRuntimeError(error)}
    expect(failure).toMatchObject({error_code:'CONTEXT_BUDGET_EXCEEDED',phase:'context',category:'context_budget',retryable:false})
    expect(failure?.user_message).toContain('尚未发送');expect(failure?.status).toBeUndefined()
  })
  it('maps provider status and preserves the original provider detail', () => {
    const error = new ModelProviderError('Model API 429: busy', 429, 2500, 'rate_limit', {
      status: 429,
      category: 'rate_limit',
      body: '{"error":"busy"}',
      requestId: 'request-1',
    })
    const failure = normalizeRuntimeError(error, 'model')
    expect(failure).toMatchObject({ error_code: 'MODEL_RATE_LIMITED', retryable: true, retryAfterMs: 2500, provider_error: { requestId: 'request-1' } })
    expect(runtimeFailurePayload(failure)).toMatchObject({ error_code: 'MODEL_RATE_LIMITED', error_category: 'rate_limit', provider_error: { body: '{"error":"busy"}' } })
  })

  it('distinguishes a text-only model from an incompatible image transport', () => {
    const model = normalizeRuntimeError(new Error('Model only supports text input'), 'model', { hasImageAttachments: true })
    const format = normalizeRuntimeError(new Error('Unsupported content type image_url; data URL is invalid'), 'model', { hasImageAttachments: true })
    expect(model).toMatchObject({ error_code: 'MODEL_VISION_UNSUPPORTED', disableVision: true })
    expect(format).toMatchObject({ error_code: 'IMAGE_INPUT_FORMAT_UNSUPPORTED' })
    expect(format.disableVision).toBeUndefined()
  })
})
