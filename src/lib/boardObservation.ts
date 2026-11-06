/** Desktop assembly and backwards-compatible facade. No domain decisions here. */
import {createBoardObserver} from './boardObservationDomain'
import {liveBoardRenderPort} from './boardRenderProbe'
export {RENDERER_FINGERPRINT,registerRenderProbe,type Probe} from './boardRenderProbe'
export {documentSignature,boardContentHash,type Observation,type ObservationFinding,type RenderEvidence} from './boardObservationProtocol'
export {createBoardObserver,observationSummary,observationPage} from './boardObservationDomain'
const observer=createBoardObserver(liveBoardRenderPort)
export const {trackBoardVersion,getObservation,observeBoard}=observer
export {repairNewNodes,confirmRepair} from './boardRepair'
