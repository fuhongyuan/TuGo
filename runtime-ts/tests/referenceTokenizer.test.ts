import {describe,it,expect} from 'vitest'
import {referenceTextTokens} from '../src/referenceTokenizer.js'
import {projectContext} from '../src/contextProjection.js'
describe('reference encoding with uncertainty allowance',()=>{
 it('does not mistake Chinese UTF-8 bytes or JSON characters for tokens, including missing usage',()=>{
  const text='长思考'.repeat(7311),input={messages:[{role:'assistant' as const,content:'',reasoning:text}],outputTokens:32768}
  expect(referenceTextTokens(text)).toBeLessThan(Buffer.byteLength(text)/2)
  const view=projectContext({...input,textEstimator:'reference_bpe'},{contextWindow:100000})
  expect(view.decision.admitted).toBe(true);expect(view.decision.estimator).toBe('reference-bpe-with-margin-v1')
  expect(view.decision.limitations).toContain('not_a_provider_tokenizer')
 })
 it('handles literal special-token strings and surrogate pairs, deterministically and without network',()=>{
  const value='🧭约束<|endoftext|><|im_start|>'.repeat(100)
  const a=referenceTextTokens(value);expect(a).toBeGreaterThan(0);expect(referenceTextTokens(value)).toBe(a)
  expect(()=>referenceTextTokens({literal:value,json:'"'.repeat(1500)})).not.toThrow()
 })
})
