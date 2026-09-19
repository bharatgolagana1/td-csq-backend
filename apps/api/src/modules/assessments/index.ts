/**
 * The module's only export. The orchestrator adds it to the array in
 * src/modules/index.ts, which this module deliberately does not edit: six
 * modules are being written against the same kernel at the same time, and one
 * shared file with six authors is a merge conflict rather than an extension
 * point.
 */
export { assessmentsModule, ASSESSMENTS_MANAGE, ASSESSMENTS_RESPOND, INSTRUMENTS_PUBLISH } from './assessments.module.js';
