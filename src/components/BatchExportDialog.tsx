import { useMemo, useState } from 'react'
import { Check, Download, FileCode2, FileImage, FileText, MessageSquarePlus, Presentation, X } from 'lucide-react'
import type { BoardDocument, CanvasReference } from '../types'
import { buildRegionsPptx, documentForRegion, exportRegion, type ExportFormat, type ExportRegion } from '../lib/exportDocument'

type Props = {
  document: BoardDocument
  regions: ExportRegion[]
  fileName: string
  onClose(): void
  onAddToChat(references: CanvasReference[]): void
}

const safeName = (value: string) => value.trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'TuGo'
const formats: Array<{ id: ExportFormat; title: string; icon: typeof FileImage }> = [
  { id: 'png', title: '批量导出 PNG', icon: FileImage },
  { id: 'jpeg', title: '批量导出 JPEG', icon: FileImage },
  { id: 'webp', title: '批量导出 WebP', icon: FileImage },
  { id: 'svg', title: '批量导出 SVG', icon: FileCode2 },
  { id: 'pdf', title: '批量导出 PDF', icon: FileText },
  { id: 'pptx', title: '导出 PPT', icon: Presentation },
  { id: 'drawio', title: '批量导出 draw.io', icon: FileCode2 },
]

export function BatchExportDialog({ document, regions, fileName, onClose, onAddToChat }: Props) {
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [format, setFormat] = useState<ExportFormat>('png')
  const [scale, setScale] = useState(2)
  const [transparent, setTransparent] = useState(false)
  const summary = useMemo(() => regions.reduce((total, region) => {
    const clipped = documentForRegion(document, region)
    return { elements: total.elements + clipped.elements.length, edges: total.edges + clipped.edges.length }
  }, { elements: 0, edges: 0 }), [document, regions])
  const run = async () => {
    setExporting(true); setError('')
    try {
      if (format === 'pptx') await buildRegionsPptx(document, regions, fileName).writeFile({ fileName: `${safeName(fileName)}-批量框选.pptx`, compression: true })
      else for (let index = 0; index < regions.length; index += 1) await exportRegion(document, regions[index], `${fileName}-${index + 1}`, { format, scale, transparent: transparent && ['png', 'webp', 'svg'].includes(format) })
      onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setExporting(false) }
  }
  const addToChat = () => {
    onAddToChat(regions.map((region, index) => ({ kind: 'region' as const, id: `regions:${region.x}:${region.y}:${region.width}:${region.height}:${index}`, label: `框选区域 ${index + 1}`, x: region.x, y: region.y, width: region.width, height: region.height, elementIds: documentForRegion(document, region).elements.map(item => item.id) })))
    onClose()
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !exporting) onClose() }}>
    <div className="modal export-modal" role="dialog" aria-modal="true" aria-labelledby="batch-export-dialog-title">
      <div className="modal-header"><div><small>BATCH EXPORT</small><h2 id="batch-export-dialog-title">批量导出</h2></div><button className="icon-btn" aria-label="关闭批量导出" disabled={exporting} onClick={onClose}><X size={18}/></button></div>
      <div className="export-summary"><div className="export-preview-icon"><Download size={20}/></div><div><strong>{regions.length} 个区域</strong><span>{summary.elements} 个图形 · {summary.edges} 条连线</span></div></div>
      <div className="export-format-grid">{formats.map(item => <button key={item.id} className={format === item.id ? 'active' : ''} onClick={() => setFormat(item.id)}><item.icon size={18}/><span><strong>{item.title}</strong><small>{item.id === 'pptx' ? '一个文件，每个区域一页' : '每个区域单独下载'}</small></span>{format === item.id && <Check className="format-check" size={14}/>}</button>)}<button className="export-chat-action" disabled={exporting} onClick={addToChat}><MessageSquarePlus size={18}/><span><strong>添加到对话</strong><small>让 AI 一起参考这些区域</small></span></button></div>
      <div className="export-options"><div className={['png','jpeg','webp','pdf'].includes(format) ? '' : 'disabled'}><span>清晰度</span><div className="export-segmented">{[1,2,4].map(value => <button key={value} disabled={!['png','jpeg','webp','pdf'].includes(format)} className={scale === value ? 'active' : ''} onClick={() => setScale(value)}>{value}×</button>)}</div></div><label className={['png','webp','svg'].includes(format) ? '' : 'disabled'}><span><strong>透明背景</strong><small>保留区域外透明部分</small></span><input type="checkbox" disabled={!['png','webp','svg'].includes(format)} checked={transparent} onChange={event => setTransparent(event.target.checked)}/></label></div>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-footer"><span>{format === 'pptx' ? '一个 PPT 文件，每个区域一页，图形、文字和连线可编辑。' : '所选格式会按区域分别下载。'}</span><button className="soft-btn" disabled={exporting} onClick={onClose}>取消</button><button className="primary-btn" disabled={exporting} onClick={() => void run()}>{exporting ? '正在导出…' : formats.find(item => item.id === format)?.title}</button></div>
    </div>
  </div>
}
