import { randomUUID } from 'node:crypto'
import type { JsonObject, StructuredEventType } from './contracts.js'

type PlanEvent = { type: StructuredEventType; payload: JsonObject }

const records = (value: unknown) => Array.isArray(value)
  ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as JsonObject[]
  : []

export const normalizePlan = (value: JsonObject, previous?: JsonObject): JsonObject => {
  const steps = records(value.steps).map((step, index) => ({
    id: String(step.id || `step_${index + 1}`),
    title: String(step.title || step.description || `步骤 ${index + 1}`),
    instruction: String(step.instruction || step.description || step.title || ''),
    status: String(step.status || 'pending'),
    ...(step.notes ? { notes: String(step.notes) } : {}),
    ...(step.result_summary ? { result_summary: String(step.result_summary) } : {}),
    ...(step.blocker ? { blocker: String(step.blocker) } : {}),
    ...(step.blocker ? { blocker: String(step.blocker) } : {}),
  }))
  const active = steps.find(step => step.status === 'in_progress')
  const allCompleted = steps.length > 0 && steps.every(step => step.status === 'completed')
  const blocked = steps.some(step => step.status === 'blocked' || step.status === 'failed')
  return {
    version: 2,
    plan_id: String(value.plan_id || previous?.plan_id || `plan_${randomUUID()}`),
    revision: Number(previous?.revision || 0) + 1,
    title: String(value.title || previous?.title || '执行计划'),
    status: allCompleted ? 'completed' : blocked ? 'blocked' : 'active',
    current_step_id: active?.id || null,
    steps,
  }
}

const payload = (plan: JsonObject) => ({
  version: 2,
  plan_id: plan.plan_id,
  revision: plan.revision,
  title: plan.title,
  status: plan.status,
  current_step_id: plan.current_step_id,
  steps: plan.steps,
})

export const projectPlanEvents = (previous: JsonObject | undefined, current: JsonObject): PlanEvent[] => {
  const events: PlanEvent[] = [{ type: previous ? 'plan.updated' : 'plan.snapshot', payload: payload(current) }]
  const oldSteps = new Map(records(previous?.steps).map(step => [String(step.id), step]))
  for (const step of records(current.steps)) {
    const oldStatus = String(oldSteps.get(String(step.id))?.status || '')
    const status = String(step.status || '')
    if (status === oldStatus) continue
    const stepPayload = { ...payload(current), step_id: step.id, step }
    if (status === 'in_progress') events.push({ type: 'plan.step.started', payload: stepPayload })
    else if (status === 'completed') events.push({ type: 'plan.step.completed', payload: stepPayload })
    else if (status === 'blocked' || status === 'failed') events.push({ type: 'plan.step.blocked', payload: stepPayload })
  }
  if (current.status === 'completed') events.push({ type: 'plan.completed', payload: payload(current) })
  else if (current.status === 'abandoned') events.push({ type: 'plan.abandoned', payload: payload(current) })
  return events
}

export const planHasOpenWork = (plan: JsonObject | undefined) => Boolean(plan && plan.status === 'active' && records(plan.steps).some(step => !['completed', 'skipped', 'abandoned'].includes(String(step.status))))
