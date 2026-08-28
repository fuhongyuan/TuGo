import { Cat, MousePointer2, Plane, Rocket } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { DrawingCursorStyle } from '../types'
import tugoLogo from '../../assets/tugo-logo.png'

export function AiCursorGlyph({ cursorStyle = 'classic', color = '#4F46E5', size = 28 }: { cursorStyle?: DrawingCursorStyle; color?: string; size?: number }) {
  const style = { '--ai-cursor-color': color, width: size, height: size } as CSSProperties
  if (cursorStyle === 'tugo') return <span className="ai-cursor-glyph cursor-tugo" style={style}><img src={tugoLogo} alt="" draggable={false}/></span>
  if (cursorStyle === 'classic') return <span className="ai-cursor-glyph cursor-classic" style={style}><MousePointer2 size={size - 2} strokeWidth={2.4}/></span>
  if (cursorStyle === 'plane') return <span className="ai-cursor-glyph cursor-plane" style={style}><Plane size={size - 1} strokeWidth={2.25}/></span>
  if (cursorStyle === 'rocket') return <span className="ai-cursor-glyph cursor-rocket" style={style}><Rocket size={size - 1} strokeWidth={2.25}/></span>
  if (cursorStyle === 'cat') return <span className="ai-cursor-glyph cursor-cat" style={style}><Cat size={size - 1} strokeWidth={2.3}/><i/></span>
  if (cursorStyle === 'pixel') return <span className="ai-cursor-glyph cursor-pixel" style={style}><svg viewBox="0 0 32 32" aria-hidden="true"><path className="pixel-pointer" d="M3 2h5v5h4v4h4v4h4v4h-6v4h3v7h-6v-7H8v4H3z"/><path className="pixel-highlight" d="M5 5h3v4h4v4h-3v-2H7v8H5z"/></svg></span>
  if (cursorStyle === 'rgb') return <span className="ai-cursor-glyph cursor-rgb" style={style}><svg viewBox="0 0 32 32" aria-hidden="true"><g className="rgb-regions"><path d="M3 2 11 7 6 15 4 21z"/><path d="m11 7 7 5-5 5-7-2z"/><path d="m18 12 9 6-10 2-4-3z"/><path d="m6 15 7 2 4 3-6 3-7-2z"/><path d="m11 23 6-3 2 4-5 3z"/><path d="m19 24 3 5-6 3-2-5z"/><path d="m4 21 7 2-7 7z"/></g><path className="rgb-outline" d="M3 2 27 18l-10 2 5 9-6 3-5-9-7 7z"/></svg></span>
  if (cursorStyle === 'mascot') return <span className="ai-cursor-glyph cursor-mascot" style={style}><svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="16" cy="8" r="4"/><path d="M12 14c2-2 7-2 9 1l3 5-3 2-3-4v8h-5v-8l-5 4-2-3z"/><path className="mascot-pointer" d="m3 3 8 3-4 2-2 4z"/></svg></span>
  if (cursorStyle === 'tank') return <span className="ai-cursor-glyph cursor-tank" style={style}><svg viewBox="0 0 30 28" aria-hidden="true"><path className="tank-barrel" d="m15 8 10-6 2 3-10 7z"/><rect x="9" y="8" width="11" height="8" rx="3"/><path d="M5 15h18l3 7-3 4H6l-3-4z"/><circle cx="8" cy="22" r="2"/><circle cx="14" cy="22" r="2"/><circle cx="20" cy="22" r="2"/></svg></span>
  if (cursorStyle === 'voxel_sword') return <span className="ai-cursor-glyph cursor-voxel-sword" style={style}><svg viewBox="0 0 28 28" aria-hidden="true"><path className="blade" d="M21 2h5v5L12 21l-5-5z"/><path className="guard" d="m7 13 8 8-3 3-8-8z"/><path className="grip" d="m6 19 3 3-5 5-3-3z"/></svg></span>
  if (cursorStyle === 'pixel_star') return <span className="ai-cursor-glyph cursor-pixel-star" style={style}><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M11 2h6v6h6v6h4v6h-8v6H9v-6H1v-6h4V8h6z"/></svg></span>
  return <span className="ai-cursor-glyph cursor-neon-leek" style={style}><svg viewBox="0 0 32 32" aria-hidden="true"><path className="leaf leaf-left" d="M13 18C10 13 8 7 10 2c4 5 6 10 7 16z"/><path className="leaf leaf-center" d="M15 18c-1-7 0-13 3-17 2 7 1 12-1 18z"/><path className="leaf leaf-right" d="M17 19c2-6 6-10 11-12-2 7-5 11-9 14z"/><path className="collar" d="M11 16c3-1 7-1 10 1l-1 6H12z"/><path className="stalk" d="m12 21 8 1-1 8c-2 2-6 2-8 0z"/><path className="roots" d="m12 29-2 2m5-2v3m3-3 2 2"/></svg></span>
}
