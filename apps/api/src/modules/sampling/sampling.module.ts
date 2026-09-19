import { defineModule } from '../../kernel/router.js';
import { parseBody, parseParams, parseQuery } from '../../kernel/validate.js';
import {
  ApproveBatch,
  AuditQuery,
  BatchIdParam,
  BatchQuery,
  ContactIdParam,
  ContactQuery,
  CreateBatch,
  CreateContact,
  CycleIdParam,
  CyclePolicyBody,
  ExportQuery,
  ImportIdParam,
  RejectBatch,
  ReviewAdd,
  ReviewCorrect,
  ReviewRemove,
  SamplingSettingsPatch,
  SetSelection,
  UpdateContact,
  ValidateImport,
} from './sampling.contracts.js';
import { listAudit } from './sampling.audit.js';
import {
  createContact,
  deactivateContact,
  exportContactsCsv,
  listContacts,
  readContact,
  updateContact,
} from './sampling.contacts.js';
import { commitImport, readImport, validateImport } from './sampling.import.js';
import { readIntegrity } from './sampling.integrity.js';
import {
  approveBatch,
  createBatch,
  diffBatch,
  listBatches,
  lockBatch,
  previewGate,
  readBatch,
  rejectBatch,
  reviewAdd,
  reviewCorrect,
  reviewRemove,
  setSelection,
} from './sampling.batches.js';
import {
  patchSamplingSettings,
  putCyclePolicy,
  readCyclePolicy,
  readSamplingSettings,
} from './sampling.policy.js';

export const SAMPLING_READ = 'sampling:read';
export const SAMPLING_ADMINISTER = 'sampling:administer';
export const SAMPLING_CONTACTS_WRITE = 'sampling.contacts:write';
export const SAMPLING_BATCHES_WRITE = 'sampling.batches:write';
export const SAMPLING_REVIEW = 'sampling:review';

/**
 * Reviewing a sample is held apart from building one. The whole point of the
 * SUPER_ADMIN approval mode is that the operator who chose who grades it is not
 * the person who signs that choice off, and that separation has to exist in the
 * capability set or it does not exist at all.
 */
export const samplingModule = defineModule({
  name: 'sampling',
  basePath: '/v1/sampling',
  capabilities: [
    SAMPLING_READ,
    SAMPLING_ADMINISTER,
    SAMPLING_CONTACTS_WRITE,
    SAMPLING_BATCHES_WRITE,
    SAMPLING_REVIEW,
  ],
  routes: [
    {
      method: 'get',
      path: '/settings',
      summary: 'Sampling settings for this organisation',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: () => readSamplingSettings(),
    },
    {
      method: 'patch',
      path: '/settings',
      summary: 'Update sampling settings',
      policy: { requiredCapability: SAMPLING_ADMINISTER, tenancy: 'ORG' },
      handler: (req) => patchSamplingSettings(parseBody(SamplingSettingsPatch, req)),
    },
    {
      method: 'get',
      path: '/cycles/:cycleId/policy',
      summary: 'Sampling windows and minimum for one cycle',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: (req) => readCyclePolicy(parseParams(CycleIdParam, req).cycleId, new Date()),
    },
    {
      method: 'put',
      path: '/cycles/:cycleId/policy',
      summary: 'Set the sampling windows and minimum for one cycle',
      policy: { requiredCapability: SAMPLING_ADMINISTER, tenancy: 'ORG' },
      handler: (req) =>
        putCyclePolicy(parseParams(CycleIdParam, req).cycleId, parseBody(CyclePolicyBody, req)),
    },

    {
      method: 'get',
      path: '/contacts',
      summary: 'List the customer directory',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: (req) => listContacts(parseQuery(ContactQuery, req)),
    },
    {
      method: 'post',
      path: '/contacts',
      summary: 'Add a customer contact',
      status: 201,
      policy: { requiredCapability: SAMPLING_CONTACTS_WRITE, tenancy: 'ORG' },
      handler: (req) => createContact(parseBody(CreateContact, req)),
    },
    // declared before /contacts/:contactId, which would otherwise swallow it
    {
      method: 'get',
      path: '/contacts/export',
      summary: 'Export the directory as the CSV the import reads back',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: async (req, res) => {
        const csv = await exportContactsCsv(parseQuery(ExportQuery, req));
        res
          .status(200)
          .type('text/csv; charset=utf-8')
          .set('content-disposition', 'attachment; filename="customer-contacts.csv"')
          .send(csv);
      },
    },
    {
      method: 'post',
      path: '/contacts/import/validate',
      summary: 'Check an import and report every row before anything is written',
      policy: { requiredCapability: SAMPLING_CONTACTS_WRITE, tenancy: 'ORG' },
      handler: (req) => validateImport(parseBody(ValidateImport, req)),
    },
    {
      method: 'get',
      path: '/contacts/imports/:importId',
      summary: 'Read a validated or committed import',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: (req) => readImport(parseParams(ImportIdParam, req).importId),
    },
    {
      method: 'post',
      path: '/contacts/imports/:importId/commit',
      summary: 'Write a validated import into the directory',
      policy: { requiredCapability: SAMPLING_CONTACTS_WRITE, tenancy: 'ORG' },
      handler: (req) => commitImport(parseParams(ImportIdParam, req).importId),
    },
    {
      method: 'get',
      path: '/contacts/:contactId',
      summary: 'Read one customer contact',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: (req) => readContact(parseParams(ContactIdParam, req).contactId),
    },
    {
      method: 'patch',
      path: '/contacts/:contactId',
      summary: 'Correct a customer contact',
      policy: { requiredCapability: SAMPLING_CONTACTS_WRITE, tenancy: 'ORG' },
      handler: (req) =>
        updateContact(parseParams(ContactIdParam, req).contactId, parseBody(UpdateContact, req)),
    },
    {
      method: 'delete',
      path: '/contacts/:contactId',
      summary: 'Deactivate a customer contact',
      policy: { requiredCapability: SAMPLING_CONTACTS_WRITE, tenancy: 'ORG' },
      handler: (req) => deactivateContact(parseParams(ContactIdParam, req).contactId),
    },

    {
      method: 'get',
      path: '/batches',
      summary: 'List sampling batches',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: (req) => listBatches(parseQuery(BatchQuery, req)),
    },
    {
      method: 'post',
      path: '/batches',
      summary: 'Start a sampling batch',
      status: 201,
      policy: { requiredCapability: SAMPLING_BATCHES_WRITE, tenancy: 'ORG' },
      handler: (req) => createBatch(parseBody(CreateBatch, req), new Date()),
    },
    {
      method: 'get',
      path: '/batches/:batchId',
      summary: 'Read one sampling batch',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: (req) => readBatch(parseParams(BatchIdParam, req).batchId),
    },
    {
      method: 'put',
      path: '/batches/:batchId/selection',
      summary: 'Set the contacts a draft batch will lock',
      policy: { requiredCapability: SAMPLING_BATCHES_WRITE, tenancy: 'ORG' },
      handler: (req) =>
        setSelection(parseParams(BatchIdParam, req).batchId, parseBody(SetSelection, req).contactIds),
    },
    {
      method: 'get',
      path: '/batches/:batchId/gate',
      summary: 'What the lock gate would say about this batch right now',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: (req) => previewGate(parseParams(BatchIdParam, req).batchId),
    },
    {
      method: 'post',
      path: '/batches/:batchId/lock',
      summary: 'Lock the sample',
      policy: { requiredCapability: SAMPLING_BATCHES_WRITE, tenancy: 'ORG' },
      handler: (req) => lockBatch(parseParams(BatchIdParam, req).batchId, new Date()),
    },
    {
      method: 'get',
      path: '/batches/:batchId/diff',
      summary: 'What review changed against what the operator submitted',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: (req) => diffBatch(parseParams(BatchIdParam, req).batchId),
    },
    {
      method: 'get',
      path: '/batches/:batchId/integrity',
      summary: 'Integrity observations recorded at the lock',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: (req) => readIntegrity(parseParams(BatchIdParam, req).batchId),
    },
    {
      method: 'post',
      path: '/batches/:batchId/review/add',
      summary: 'Add contacts to a batch under review',
      policy: { requiredCapability: SAMPLING_REVIEW, tenancy: 'ORG' },
      handler: (req) => {
        const { contactIds, reasonCode, note } = parseBody(ReviewAdd, req);
        return reviewAdd(parseParams(BatchIdParam, req).batchId, contactIds, reasonCode, note);
      },
    },
    {
      method: 'post',
      path: '/batches/:batchId/review/remove',
      summary: 'Remove contacts from a batch under review',
      policy: { requiredCapability: SAMPLING_REVIEW, tenancy: 'ORG' },
      handler: (req) => {
        const { contactIds, reasonCode, note } = parseBody(ReviewRemove, req);
        return reviewRemove(parseParams(BatchIdParam, req).batchId, contactIds, reasonCode, note);
      },
    },
    {
      method: 'post',
      path: '/batches/:batchId/review/correct',
      summary: 'Correct a contact in a batch under review',
      policy: { requiredCapability: SAMPLING_REVIEW, tenancy: 'ORG' },
      handler: (req) => {
        const { contactId, changes, reasonCode, note } = parseBody(ReviewCorrect, req);
        return reviewCorrect(parseParams(BatchIdParam, req).batchId, contactId, changes, reasonCode, note);
      },
    },
    {
      method: 'post',
      path: '/batches/:batchId/approve',
      summary: 'Approve a reviewed sample',
      policy: { requiredCapability: SAMPLING_REVIEW, tenancy: 'ORG' },
      handler: (req) => approveBatch(parseParams(BatchIdParam, req).batchId, parseBody(ApproveBatch, req).note),
    },
    {
      method: 'post',
      path: '/batches/:batchId/reject',
      summary: 'Reject a sample, with reasons',
      policy: { requiredCapability: SAMPLING_REVIEW, tenancy: 'ORG' },
      handler: (req) => rejectBatch(parseParams(BatchIdParam, req).batchId, parseBody(RejectBatch, req)),
    },

    {
      method: 'get',
      path: '/audit',
      summary: 'The append only trail of directory and batch mutations',
      policy: { requiredCapability: SAMPLING_READ, tenancy: 'ORG' },
      handler: (req) => listAudit(parseQuery(AuditQuery, req)),
    },
  ],
});
