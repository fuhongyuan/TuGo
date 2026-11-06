import type {ObservationRecord} from './observationProtocol.js'
/** Scope is resolved by the trusted host, never copied from model arguments. */
export type EvidenceScope=ObservationRecord['scope']
export type EvidenceEntry={record:ObservationRecord;payload:unknown;expiresAt:string}
export interface EvidencePort {
 put(record:ObservationRecord,payload:unknown):Promise<string>
 get(ref:string,scope:EvidenceScope):Promise<EvidenceEntry>
 cleanup():Promise<number>
}
export type EvidenceErrorCode='invalid'|'forbidden'|'not_found'|'expired'|'corrupt'|'quota'|'busy'|'storage'|'sensitive'
export class EvidenceError extends Error {
 constructor(readonly code:EvidenceErrorCode){super(`Evidence unavailable: ${code}`)}
}
