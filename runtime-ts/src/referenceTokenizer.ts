import {createHash} from 'node:crypto'
import {Tiktoken} from 'js-tiktoken/lite'
import ranks from 'js-tiktoken/ranks/o200k_base'
let encoder:Tiktoken|undefined
const cache=new Map<string,number>()
const chunks=new Map<string,number>()
/** Local reference encoding, NOT an exact tokenizer for arbitrary gateways.
 * Chunk boundaries and 25% uncertainty allowance deliberately over-reserve.
 * Special-token-looking user text is ordinary data, never a control token.
 */
export function referenceTextTokens(value:unknown) {
 const text=typeof value==='string'?value:JSON.stringify(value??'')
 const key=createHash('sha256').update(text).digest('hex'),found=cache.get(key)
 if(found!==undefined)return found
 encoder??=new Tiktoken(ranks)
 let total=0
 for(let start=0;start<text.length;){
  let end=Math.min(text.length,start+512);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--
  const chunk=text.slice(start,end);let count=chunks.get(chunk)
  if(count===undefined){count=encoder.encode(chunk,[],[]).length;chunks.set(chunk,count);if(chunks.size>512)chunks.delete(chunks.keys().next().value!)}
  total+=count;start=end
 }
 const count=Math.ceil(total*1.25)
 cache.set(key,count);if(cache.size>256)cache.delete(cache.keys().next().value!)
 return count
}
