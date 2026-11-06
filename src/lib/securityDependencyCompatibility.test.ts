import {it,expect} from 'vitest'
import DOMPurify from 'dompurify'
import {imageSize} from 'image-size'
import {readFileSync} from 'node:fs'
it('retains safe SVG output while removing scripts and active handlers',()=>{
 const clean=DOMPurify.sanitize('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><path d="M0 0 L10 10"/></svg>',{USE_PROFILES:{svg:true}})
 expect(clean).toContain('<path');expect(clean).not.toContain('<script');expect(clean).not.toContain('onload')
})
it('keeps PNG dimension reading compatible with the patched major parser',()=>{
 const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1OwAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0))
 expect(imageSize(bytes)).toMatchObject({width:1,height:1,type:'png'})
})
it('declares the build runner directly and pins targeted security overrides',()=>{
 const pkg=JSON.parse(readFileSync('package.json','utf8'))
 expect(pkg.devDependencies['vite-node']).toBeTruthy();expect(pkg.overrides.pptxgenjs['image-size']).toBe('^2.0.4');expect(pkg.overrides['@electron/asar'].glob).toBe('^14.0.3')
})
