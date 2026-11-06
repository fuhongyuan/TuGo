import {it,expect} from 'vitest'
import validate from './cliValidator.generated'
it('retains Unicode code-point limits in the standalone CSP-safe validator',()=>{
 const operations=[{op:'set_palette',paletteId:'default'}]
 expect(validate({description:'😀'.repeat(160),operations})).toBe(true)
 expect(validate({description:'😀'.repeat(161),operations})).toBe(false)
 expect(validate({description:'中文说明',operations})).toBe(true)
})
