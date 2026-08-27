import type { ArrowStyle, BoardEdge, BoardElement, EdgeRouting, StrokeStyle } from '../types'

export type ColorPalette = {
  id: string
  name: string
  description: string
  colors: Array<{ fill: string; stroke: string; text: string }>
}

export const colorPalettes: ColorPalette[] = [
  { id: 'macaron', name: '马卡龙', description: '轻盈柔和', colors: [
    { fill: '#FDE2E4', stroke: '#C96D75', text: '#62383C' }, { fill: '#FAD2E1', stroke: '#B96A8B', text: '#5E3448' },
    { fill: '#E2ECE9', stroke: '#5E8F82', text: '#31534A' }, { fill: '#BEE1E6', stroke: '#4E8790', text: '#2D5157' },
    { fill: '#DFE7FD', stroke: '#657CB8', text: '#344269' }, { fill: '#FFF1C7', stroke: '#B38B32', text: '#66501F' },
  ] },
  { id: 'vivid', name: '高饱和', description: '醒目有活力', colors: [
    { fill: '#FF6B6B', stroke: '#B83232', text: '#4A1010' }, { fill: '#FFB020', stroke: '#B56D00', text: '#513100' },
    { fill: '#FFE14D', stroke: '#A98900', text: '#4A3C00' }, { fill: '#4DDB8A', stroke: '#12834A', text: '#073E24' },
    { fill: '#36C5F0', stroke: '#087E9F', text: '#063F50' }, { fill: '#7C6CF2', stroke: '#4736B8', text: '#21176B' },
  ] },
  { id: 'business', name: '商务', description: '稳重清晰', colors: [
    { fill: '#DCE6F2', stroke: '#496A8E', text: '#253A52' }, { fill: '#D9E8E5', stroke: '#477A70', text: '#24463F' },
    { fill: '#E4E0EC', stroke: '#6C6084', text: '#3B354A' }, { fill: '#EEE5D8', stroke: '#8A6E49', text: '#4D3C27' },
    { fill: '#E2E7ED', stroke: '#5F6D7C', text: '#303A45' }, { fill: '#DDE7D7', stroke: '#637B55', text: '#35432E' },
  ] },
  { id: 'nature', name: '自然', description: '森林与大地', colors: [
    { fill: '#DDE5B6', stroke: '#78864E', text: '#3F4728' }, { fill: '#ADC178', stroke: '#5D7131', text: '#2D3916' },
    { fill: '#A7C4A0', stroke: '#52744A', text: '#294025' }, { fill: '#DDBEA9', stroke: '#946D55', text: '#503A2D' },
    { fill: '#CB997E', stroke: '#805642', text: '#422B20' }, { fill: '#EDE0D4', stroke: '#9B7C65', text: '#554335' },
  ] },
  { id: 'mono', name: '单色蓝', description: '统一而克制', colors: [
    { fill: '#EFF6FF', stroke: '#60A5FA', text: '#1E3A5F' }, { fill: '#DBEAFE', stroke: '#3B82F6', text: '#1E3A5F' },
    { fill: '#BFDBFE', stroke: '#2563EB', text: '#172F57' }, { fill: '#93C5FD', stroke: '#1D4ED8', text: '#102A56' },
    { fill: '#60A5FA', stroke: '#1E40AF', text: '#0B2350' }, { fill: '#3B82F6', stroke: '#1E3A8A', text: '#FFFFFF' },
  ] },
]

export const strokeDasharray = (style?: StrokeStyle, legacyDashed?: boolean) => {
  const value = style || (legacyDashed ? 'dashed' : 'solid')
  return value === 'dashed' ? '10 7' : value === 'dotted' ? '2 6' : undefined
}

export const elementStyle = (element: BoardElement) => ({
  fill: element.fill,
  stroke: element.stroke,
  strokeWidth: element.strokeWidth,
  strokeDasharray: strokeDasharray(element.strokeStyle),
  fillOpacity: element.fillOpacity ?? 1,
  opacity: element.opacity ?? 1,
})

export const edgeDefaults = (edge: BoardEdge): Required<Pick<BoardEdge, 'startArrow' | 'endArrow' | 'routing' | 'strokeStyle' | 'opacity' | 'zIndex'>> => ({
  startArrow: edge.startArrow || (edge.arrowStart ? 'arrow' : 'none'),
  endArrow: edge.endArrow || (edge.arrowEnd ? 'arrow' : 'none'),
  routing: edge.routing || 'curve',
  strokeStyle: edge.strokeStyle || (edge.dashed ? 'dashed' : 'solid'),
  opacity: edge.opacity ?? 1,
  zIndex: edge.zIndex ?? 0,
})

export const arrowStyles: Array<{ id: ArrowStyle; label: string }> = [
  { id: 'none', label: '无' }, { id: 'arrow', label: '箭头' }, { id: 'triangle', label: '实心' }, { id: 'circle', label: '圆点' }, { id: 'diamond', label: '菱形' },
]
export const lineStyles: Array<{ id: StrokeStyle; label: string }> = [
  { id: 'solid', label: '实线' }, { id: 'dashed', label: '虚线' }, { id: 'dotted', label: '点线' },
]
export const routingStyles: Array<{ id: EdgeRouting; label: string }> = [
  { id: 'curve', label: '曲线' }, { id: 'straight', label: '直线' }, { id: 'polyline', label: '折线' },
]
