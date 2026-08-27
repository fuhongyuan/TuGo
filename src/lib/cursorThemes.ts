import type { DrawingCursorStyle } from '../types'

export const drawingCursorThemes: Array<{ id: DrawingCursorStyle; name: string; description: string; nameEn: string; descriptionEn: string }> = [
  { id: 'tugo', name: '图狗', description: 'TuGo 的默认创作搭档', nameEn: 'TuGo', descriptionEn: 'TuGo’s default creative companion' },
  { id: 'classic', name: '经典', description: '清晰的指针箭头', nameEn: 'Classic', descriptionEn: 'A precise pointer arrow' },
  { id: 'pixel', name: '8-bit', description: '像素游戏风格', nameEn: '8-bit', descriptionEn: 'Pixel-game style' },
  { id: 'rgb', name: 'RGB', description: '动态三色光影', nameEn: 'RGB', descriptionEn: 'Animated color trails' },
  { id: 'plane', name: '纸飞机', description: '轻快地飞向目标', nameEn: 'Paper plane', descriptionEn: 'Glides toward the target' },
  { id: 'rocket', name: '火箭', description: '适合高速创作', nameEn: 'Rocket', descriptionEn: 'Made for fast creation' },
  { id: 'cat', name: '小猫', description: '跟着猫爪一起画', nameEn: 'Cat', descriptionEn: 'Draw with a tiny companion' },
  { id: 'mascot', name: '小助手', description: '指向正在编辑的位置', nameEn: 'Helper', descriptionEn: 'Points at the active edit' },
  { id: 'tank', name: '坦克', description: '履带向目标推进', nameEn: 'Tank', descriptionEn: 'Rolls toward the target' },
  { id: 'voxel_sword', name: '方块剑', description: '原创体素冒险风', nameEn: 'Voxel blade', descriptionEn: 'Original block-adventure style' },
  { id: 'pixel_star', name: '像素星', description: '原创街机能量符号', nameEn: 'Pixel star', descriptionEn: 'Original arcade energy symbol' },
  { id: 'neon_leek', name: '霓虹葱', description: '原创电音蔬菜梗', nameEn: 'Neon leek', descriptionEn: 'Original electronic veggie meme' },
]

export const drawingCursorColors = ['#4F46E5', '#0F766E', '#0284C7', '#DB2777', '#EA580C', '#CA8A04', '#7C3AED', '#334155']
