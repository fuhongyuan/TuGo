import { AlignCenter, AlignEndHorizontal, AlignHorizontalDistributeCenter, AlignLeft, AlignStartHorizontal, AlignVerticalDistributeCenter, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, Bold, BringToFront, ChevronDown, ChevronUp, Copy, Group, Italic, Lock, Rows3, SendToBack, Trash2, Underline, Ungroup, Unlock } from 'lucide-react'
import { alignOperations, distributeOperations, groupOperations, layerOperations, patchSelected, selectedElements, ungroupOperations } from '../lib/boardCommands'
import type { BoardDocument, BoardOperation, CanvasReference, TextAlign } from '../types'

type Props = {
  x: number; y: number; document: BoardDocument; selectedIds: string[]; canPaste: boolean
  onCommit(operations: BoardOperation[]): void; onSelect(ids: string[]): void; onCopy(): void; onPaste(): void; onDuplicate(): void; onEditText(id: string): void; onAddToChat(references: CanvasReference[]): void; onClose(): void
}

const textFonts = ['Inter', 'Arial', 'Georgia', 'Courier New', 'PingFang SC']

export function CanvasContextMenu({ x, y, document, selectedIds, canPaste, onCommit, onSelect, onCopy, onPaste, onDuplicate, onEditText, onAddToChat, onClose }: Props) {
  const elements = selectedElements(document, selectedIds)
  const edge = selectedIds.length === 1 ? document.edges.find(item => item.id === selectedIds[0]) : undefined
  const commit = (operations: BoardOperation[], close = true) => { if (operations.length) onCommit(operations); if (close) onClose() }
  const patchText = (patch: Parameters<typeof patchSelected>[2]) => commit(patchSelected(document, selectedIds, patch), false)
  const remove = () => commit(selectedIds.map(id => ({ op: document.edges.some(edgeItem => edgeItem.id === id) ? 'delete_edge' : 'delete_element', id } as BoardOperation)))

  if (!selectedIds.length) return <div className="canvas-context-menu glass" style={{ left: x, top: y, maxHeight: `calc(100% - ${y + 8}px)` }} onPointerDown={event => event.stopPropagation()}>
    <MenuButton icon={<Copy size={15}/>} label="粘贴" shortcut="⌘V" disabled={!canPaste} onClick={() => { onPaste(); onClose() }}/>
    <MenuButton icon={<Rows3 size={15}/>} label="全选" shortcut="⌘A" onClick={() => { onSelect(document.elements.filter(item => !item.locked).map(item => item.id)); onClose() }}/>
  </div>

  const edgeReference = edge ? [{ kind: 'edge' as const, id: edge.id, label: edge.label || '未命名连线', from: edge.from || undefined, to: edge.to || undefined }] : []
  if (edge) return <div className="canvas-context-menu glass" style={{ left: x, top: y, maxHeight: `calc(100% - ${y + 8}px)` }} onPointerDown={event => event.stopPropagation()}>
    <div className="context-heading">连线</div>
    <MenuButton label="添加到对话" onClick={() => { onAddToChat(edgeReference); onClose() }}/>
    <MenuButton label="编辑标签" onClick={() => { const label = window.prompt('连线标签', edge.label || ''); if (label !== null) commit([{ op: 'patch_edge', id: edge.id, patch: { label } }]); else onClose() }}/>
    <MenuButton label="反转方向" onClick={() => commit([{ op: 'patch_edge', id: edge.id, patch: { from: edge.to, to: edge.from, startArrow: edge.endArrow, endArrow: edge.startArrow } }])}/>
    <div className="context-separator"/>
    <MenuButton icon={<Trash2 size={15}/>} label="删除连线" shortcut="⌫" danger onClick={remove}/>
  </div>

  const first = elements[0]
  const allLocked = elements.every(item => item.locked)
  const grouped = elements.some(item => item.groupId)
  const elementReferences: CanvasReference[] = elements.length > 1 ? (() => {
    const x = Math.min(...elements.map(item => item.x)), y = Math.min(...elements.map(item => item.y))
    const right = Math.max(...elements.map(item => item.x + item.width)), bottom = Math.max(...elements.map(item => item.y + item.height))
    return [{ kind: 'region' as const, id: `region:${elements.map(item => item.id).join(',')}`, label: `选区（${elements.length} 个图形）`, x, y, width: right - x, height: bottom - y, elementIds: elements.map(item => item.id) }]
  })() : elements.map(item => ({ kind: 'element', id: item.id, label: item.text || item.kind, text: item.text || undefined, x: item.x, y: item.y, width: item.width, height: item.height }))
  return <div className="canvas-context-menu canvas-context-menu-wide glass" style={{ left: x, top: y, maxHeight: `calc(100% - ${y + 8}px)` }} onPointerDown={event => event.stopPropagation()}>
    <div className="context-heading">{elements.length > 1 ? `已选择 ${elements.length} 个对象` : '对象'}</div>
    {elements.length === 1 && <MenuButton label="编辑文字" onClick={() => onEditText(first.id)}/>}
    <MenuButton label="添加到对话" onClick={() => { onAddToChat(elementReferences); onClose() }}/>
    <div className="context-format-row">
      <select title="字体" value={first.fontFamily || 'Inter'} onChange={event => patchText({ fontFamily: event.target.value })}>{textFonts.map(font => <option key={font}>{font}</option>)}</select>
      <input title="字号" type="number" min="8" max="96" value={first.fontSize} onChange={event => patchText({ fontSize: Math.max(8, Number(event.target.value)) })}/>
      <input title="文字颜色" type="color" value={first.textColor || '#263145'} onChange={event => patchText({ textColor: event.target.value })}/>
    </div>
    <div className="context-icon-row">
      <IconButton title="粗体" active={first.fontWeight === 'bold'} onClick={() => patchText({ fontWeight: first.fontWeight === 'bold' ? 'normal' : 'bold' })}><Bold size={15}/></IconButton>
      <IconButton title="斜体" active={first.fontStyle === 'italic'} onClick={() => patchText({ fontStyle: first.fontStyle === 'italic' ? 'normal' : 'italic' })}><Italic size={15}/></IconButton>
      <IconButton title="下划线" active={first.textDecoration === 'underline'} onClick={() => patchText({ textDecoration: first.textDecoration === 'underline' ? 'none' : 'underline' })}><Underline size={15}/></IconButton>
      <span/>
      {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignEndHorizontal]] as const).map(([align, Icon]) => <IconButton key={align} title={`${align} 对齐`} active={(first.textAlign || 'center') === align} onClick={() => patchText({ textAlign: align as TextAlign })}><Icon size={15}/></IconButton>)}
    </div>
    <div className="context-vertical-row"><span>垂直对齐</span>{([['top','顶部'],['middle','居中'],['bottom','底部']] as const).map(([align,label])=><button key={align} className={(first.verticalAlign||'middle')===align?'active':''} onClick={()=>patchText({verticalAlign:align})}>{label}</button>)}</div>
    {elements.length > 1 && <>
      <div className="context-separator"/><div className="context-heading">对齐与分布</div>
      <div className="context-icon-row context-align-grid">
        <IconButton title="左对齐" onClick={() => commit(alignOperations(document, selectedIds, 'left'))}><AlignStartHorizontal size={16}/></IconButton>
        <IconButton title="水平居中" onClick={() => commit(alignOperations(document, selectedIds, 'center'))}><AlignHorizontalDistributeCenter size={16}/></IconButton>
        <IconButton title="右对齐" onClick={() => commit(alignOperations(document, selectedIds, 'right'))}><AlignEndHorizontal size={16}/></IconButton>
        <IconButton title="顶对齐" onClick={() => commit(alignOperations(document, selectedIds, 'top'))}><AlignVerticalJustifyStart size={16}/></IconButton>
        <IconButton title="垂直居中" onClick={() => commit(alignOperations(document, selectedIds, 'middle'))}><AlignVerticalJustifyCenter size={16}/></IconButton>
        <IconButton title="底对齐" onClick={() => commit(alignOperations(document, selectedIds, 'bottom'))}><AlignVerticalJustifyEnd size={16}/></IconButton>
        <IconButton title="水平等距分布" disabled={elements.length < 3} onClick={() => commit(distributeOperations(document, selectedIds, 'horizontal'))}><AlignHorizontalDistributeCenter size={16}/></IconButton>
        <IconButton title="垂直等距分布" disabled={elements.length < 3} onClick={() => commit(distributeOperations(document, selectedIds, 'vertical'))}><AlignVerticalDistributeCenter size={16}/></IconButton>
      </div>
    </>}
    <div className="context-separator"/>
    <MenuButton icon={<Copy size={15}/>} label="复制" shortcut="⌘C" onClick={() => { onCopy(); onClose() }}/>
    <MenuButton label="剪切" shortcut="⌘X" onClick={() => { onCopy(); remove() }}/>
    <MenuButton label="创建副本" shortcut="⌘D" onClick={() => { onDuplicate(); onClose() }}/>
    {elements.length > 1 && !grouped && <MenuButton icon={<Group size={15}/>} label="成组" shortcut="⌘G" onClick={() => commit(groupOperations(document, selectedIds))}/>} 
    {grouped && <MenuButton icon={<Ungroup size={15}/>} label="取消成组" shortcut="⇧⌘G" onClick={() => commit(ungroupOperations(document, selectedIds))}/>} 
    <MenuButton icon={allLocked ? <Unlock size={15}/> : <Lock size={15}/>} label={allLocked ? '解锁' : '锁定'} onClick={() => commit(patchSelected(document, selectedIds, { locked: !allLocked }))}/>
    <MenuButton label="顺时针旋转 90°" onClick={() => commit(elements.filter(item => !item.locked).map(item => ({ op: 'patch_element', id: item.id, patch: { rotation: ((item.rotation || 0) + 90) % 360 } })))}/>
    <div className="context-separator"/><div className="context-heading">图层</div>
    <MenuButton icon={<BringToFront size={15}/>} label="置于顶层" shortcut="⇧⌘]" onClick={() => commit(layerOperations(document, selectedIds, 'front'))}/>
    <MenuButton icon={<ChevronUp size={15}/>} label="上移一层" shortcut="⌘]" onClick={() => commit(layerOperations(document, selectedIds, 'forward'))}/>
    <MenuButton icon={<ChevronDown size={15}/>} label="下移一层" shortcut="⌘[" onClick={() => commit(layerOperations(document, selectedIds, 'backward'))}/>
    <MenuButton icon={<SendToBack size={15}/>} label="置于底层" shortcut="⇧⌘[" onClick={() => commit(layerOperations(document, selectedIds, 'back'))}/>
    <div className="context-separator"/><MenuButton icon={<Trash2 size={15}/>} label="删除" shortcut="⌫" danger onClick={remove}/>
  </div>
}

function MenuButton({ icon, label, shortcut, danger, disabled, onClick }: { icon?: React.ReactNode; label: string; shortcut?: string; danger?: boolean; disabled?: boolean; onClick(): void }) {
  return <button type="button" className={`context-menu-item ${danger ? 'danger' : ''}`} disabled={disabled} onPointerDown={event => event.stopPropagation()} onClick={onClick}><span className="context-item-icon">{icon}</span><span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}</button>
}
function IconButton({ title, active, disabled, onClick, children }: { title: string; active?: boolean; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return <button type="button" title={title} className={active ? 'active' : ''} disabled={disabled} onPointerDown={event => event.stopPropagation()} onClick={onClick}>{children}</button>
}
