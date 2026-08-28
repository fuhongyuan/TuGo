import { useMemo, useState } from 'react'
import { Check, Download, FileCode2, FileImage, FileText, MessageSquarePlus, Presentation, X } from 'lucide-react'
import type { BoardDocument, CanvasReference } from '../types'
import { documentForRegion, exportRegion as exportBoardRegion, type ExportFormat, type ExportRegion } from '../lib/exportDocument'

type Props = {
  document: BoardDocument
  region: ExportRegion
  fileName: string
  onClose(): void
  onAddToChat?(reference: CanvasReference): void
}

const formats: Array<{ id: ExportFormat; title: string; note: string; icon: typeof FileImage }> = [
  { id: 'png', title: 'PNG', note: '清晰图片', icon: FileImage },
  { id: 'jpeg', title: 'JPEG', note: '较小体积', icon: FileImage },
  { id: 'webp', title: 'WebP', note: '现代图片', icon: FileImage },
  { id: 'svg', title: 'SVG', note: '无限缩放', icon: FileCode2 },
  { id: 'pdf', title: 'PDF', note: '单页文档', icon: FileText },
  { id: 'pptx', title: 'PPTX', note: '图形可编辑', icon: Presentation },
  { id: 'drawio', title: 'draw.io', note: '继续编辑', icon: FileCode2 },
]

export function ExportDialog({ document, region, fileName, onClose, onAddToChat }: Props) {
  const [format, setFormat] = useState<ExportFormat>('png')
  const [scale, setScale] = useState(2)
  const [transparent, setTransparent] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const clipped = useMemo(() => documentForRegion(document, region), [document, region])
  const supportsTransparency = format === 'png' || format === 'webp' || format === 'svg'
  const supportsScale = format === 'png' || format === 'jpeg' || format === 'webp' || format === 'pdf'

  const submit = async () => {
    setExporting(true); setError('')
    try {
      await exportBoardRegion(document, region, fileName, { format, scale, transparent: supportsTransparency && transparent })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setExporting(false)
    }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !exporting) onClose() }}>
    <div className="modal export-modal" role="dialog" aria-modal="true" aria-labelledby="export-dialog-title">
      <div className="modal-header"><div><small>EXPORT SELECTION</small><h2 id="export-dialog-title">导出框选区域</h2></div><button className="icon-btn" aria-label="关闭导出" disabled={exporting} onClick={onClose}><X size={18}/></button></div>
      <div className="export-summary">
        <div className="export-preview-icon"><Download size={20}/></div>
        <div><strong>{Math.round(region.width)} × {Math.round(region.height)}</strong><span>{clipped.elements.length} 个图形 · {clipped.edges.length} 条连线</span></div>
        <span className="export-file-name">{fileName}</span>
      </div>
      <div className="export-format-grid">
        {formats.map(item => <button key={item.id} className={format === item.id ? 'active' : ''} onClick={() => setFormat(item.id)}>
          <item.icon size={18}/><span><strong>{item.title}</strong><small>{item.note}</small></span>{format === item.id && <Check className="format-check" size={14}/>} 
        </button>)}
        <button className="export-chat-action" disabled={exporting} onClick={() => { onAddToChat?.({ kind: 'region', id: `region:${region.x}:${region.y}:${region.width}:${region.height}`, label: '框选区域', x: region.x, y: region.y, width: region.width, height: region.height, elementIds: clipped.elements.map(item => item.id) }); onClose() }}><MessageSquarePlus size={18}/><span><strong>添加到对话</strong><small>让 AI 参考这个区域</small></span></button>
      </div>
      <div className="export-options">
        <div className={!supportsScale ? 'disabled' : ''}><span>清晰度</span><div className="export-segmented">{[1,2,4].map(value => <button key={value} disabled={!supportsScale} className={scale === value ? 'active' : ''} onClick={() => setScale(value)}>{value}×</button>)}</div></div>
        <label className={!supportsTransparency ? 'disabled' : ''}><span><strong>透明背景</strong><small>保留画布外的透明区域</small></span><input type="checkbox" disabled={!supportsTransparency} checked={supportsTransparency && transparent} onChange={event => setTransparent(event.target.checked)}/></label>
      </div>
      {format === 'pptx' && <div className="export-note"><Presentation size={16}/><span>节点、文字和连线会转换成 PowerPoint 原生图形，可继续编辑。</span></div>}
      {error && <div className="form-error">{error}</div>}
      <div className="modal-footer"><span>只导出框内内容，不会改变当前画板。</span><button className="soft-btn" disabled={exporting} onClick={onClose}>取消</button><button className="primary-btn" disabled={exporting} onClick={() => void submit()}>{exporting ? '正在生成…' : `导出 ${formats.find(item => item.id === format)?.title}`}</button></div>
    </div>
  </div>
}
