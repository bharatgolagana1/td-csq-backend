import { defineModule } from '../../kernel/router.js';
import { requirePrincipal } from '../../kernel/requestContext.js';
import { parseBody, parseParams, parseQuery } from '../../kernel/validate.js';
import {
  CreateCycle,
  CreateParticipation,
  CreateProgram,
  CycleIdParam,
  CycleListQuery,
  ParticipationListQuery,
  ParticipationParams,
  ProgramIdParam,
  RemindersInput,
  UpdateCycle,
  UpdateProgram,
  WindowsInput,
  WithdrawParticipation,
} from './cycles.contracts.js';
import {
  CYCLES_OPERATE,
  CYCLES_PARTICIPATIONS_WRITE,
  CYCLES_PUBLISH,
  CYCLES_READ,
  CYCLES_SCHEDULE,
  CYCLES_SCORE,
  CYCLES_WRITE,
} from './cycles.state.js';
import {
  addParticipation,
  advanceCycle,
  createCycle,
  createProgram,
  deleteCycle,
  listCycles,
  listParticipations,
  listPrograms,
  publishCycle,
  readCycle,
  readParticipation,
  readProgram,
  removeParticipation,
  replaceReminders,
  replaceWindows,
  scheduleCycle,
  scoreCycle,
  unscheduleCycle,
  updateCycle,
  updateProgram,
  withdrawParticipation,
} from './cycles.service.js';
import { listCycleTasks } from './cycles.tasks.js';

/**
 * Cycles, programmes and participations.
 *
 * The transitions are separate endpoints rather than one endpoint taking an
 * action name, because the capability is a property of the route: scheduling a
 * cycle, running it, scoring it and publishing it are four different
 * authorities, and a single endpoint could only be guarded by the loosest of
 * them.
 *
 * There is no endpoint that opens a window early. /advance takes whatever the
 * clock has already made due, and nothing else, so an operator in a hurry and a
 * scheduled task are running the same rule.
 */

/** Every handler reads the clock once, here, rather than each service reaching for it. */
const now = (): Date => new Date();

const actor = (): { userId: string; automatic: false } => ({
  userId: requirePrincipal().userId,
  automatic: false,
});

export const cyclesModule = defineModule({
  name: 'cycles',
  basePath: '/v1/cycles',
  capabilities: [
    CYCLES_READ,
    CYCLES_WRITE,
    CYCLES_SCHEDULE,
    CYCLES_OPERATE,
    CYCLES_SCORE,
    CYCLES_PUBLISH,
    CYCLES_PARTICIPATIONS_WRITE,
  ],
  routes: [
    // the programme routes are registered before /:cycleId, so that the literal
    // path wins the match rather than being read as a cycle id
    {
      method: 'get',
      path: '/programs',
      summary: 'List assessment programmes',
      policy: { requiredCapability: CYCLES_READ, tenancy: 'ORG' },
      handler: () => listPrograms(),
    },
    {
      method: 'post',
      path: '/programs',
      summary: 'Create an assessment programme',
      status: 201,
      policy: { requiredCapability: CYCLES_WRITE, tenancy: 'ORG' },
      handler: (req) => createProgram(parseBody(CreateProgram, req)),
    },
    {
      method: 'get',
      path: '/programs/:programId',
      summary: 'Read one assessment programme',
      policy: { requiredCapability: CYCLES_READ, tenancy: 'ORG' },
      handler: (req) => readProgram(parseParams(ProgramIdParam, req).programId),
    },
    {
      method: 'patch',
      path: '/programs/:programId',
      summary: 'Update an assessment programme',
      policy: { requiredCapability: CYCLES_WRITE, tenancy: 'ORG' },
      handler: (req) =>
        updateProgram(parseParams(ProgramIdParam, req).programId, parseBody(UpdateProgram, req)),
    },
    {
      method: 'get',
      path: '/',
      summary: 'List cycles',
      policy: { requiredCapability: CYCLES_READ, tenancy: 'ORG' },
      handler: (req) => listCycles(parseQuery(CycleListQuery, req), now()),
    },
    {
      method: 'post',
      path: '/',
      summary: 'Create a draft cycle',
      status: 201,
      policy: { requiredCapability: CYCLES_WRITE, tenancy: 'ORG' },
      handler: (req) => createCycle(parseBody(CreateCycle, req), now()),
    },
    {
      method: 'get',
      path: '/:cycleId',
      summary: 'Read one cycle',
      policy: { requiredCapability: CYCLES_READ, tenancy: 'ORG' },
      handler: (req) => readCycle(parseParams(CycleIdParam, req).cycleId, now()),
    },
    {
      method: 'patch',
      path: '/:cycleId',
      summary: 'Rename a cycle or change its minimum sampling size',
      policy: { requiredCapability: CYCLES_WRITE, tenancy: 'ORG' },
      handler: (req) =>
        updateCycle(parseParams(CycleIdParam, req).cycleId, parseBody(UpdateCycle, req), now()),
    },
    {
      method: 'delete',
      path: '/:cycleId',
      summary: 'Delete a draft cycle that has never run',
      policy: { requiredCapability: CYCLES_WRITE, tenancy: 'ORG' },
      handler: (req) => deleteCycle(parseParams(CycleIdParam, req).cycleId),
    },
    {
      method: 'put',
      path: '/:cycleId/windows',
      summary: 'Replace the sampling and assessment windows of a draft cycle',
      policy: { requiredCapability: CYCLES_WRITE, tenancy: 'ORG' },
      handler: (req) =>
        replaceWindows(parseParams(CycleIdParam, req).cycleId, parseBody(WindowsInput, req), now()),
    },
    {
      method: 'put',
      path: '/:cycleId/reminders',
      summary: 'Replace the reminder schedule of a cycle',
      policy: { requiredCapability: CYCLES_WRITE, tenancy: 'ORG' },
      handler: (req) =>
        replaceReminders(
          parseParams(CycleIdParam, req).cycleId,
          parseBody(RemindersInput, req).reminders,
          now(),
        ),
    },
    {
      method: 'post',
      path: '/:cycleId/schedule',
      summary: 'Schedule a draft cycle and enqueue its window and reminder tasks',
      policy: { requiredCapability: CYCLES_SCHEDULE, tenancy: 'ORG' },
      handler: (req) => scheduleCycle(parseParams(CycleIdParam, req).cycleId, now(), actor()),
    },
    {
      method: 'post',
      path: '/:cycleId/unschedule',
      summary: 'Return a scheduled cycle to draft before sampling opens',
      policy: { requiredCapability: CYCLES_SCHEDULE, tenancy: 'ORG' },
      handler: (req) => unscheduleCycle(parseParams(CycleIdParam, req).cycleId, now(), actor()),
    },
    {
      method: 'post',
      path: '/:cycleId/advance',
      summary: 'Take every clock driven transition that is already due',
      policy: { requiredCapability: CYCLES_OPERATE, tenancy: 'ORG' },
      handler: (req) => advanceCycle(parseParams(CycleIdParam, req).cycleId, now(), actor()),
    },
    {
      method: 'post',
      path: '/:cycleId/score',
      summary: 'Mark a closed cycle as scored',
      policy: { requiredCapability: CYCLES_SCORE, tenancy: 'ORG' },
      handler: (req) => scoreCycle(parseParams(CycleIdParam, req).cycleId, now(), actor()),
    },
    {
      method: 'post',
      path: '/:cycleId/publish',
      summary: 'Publish a scored cycle',
      policy: { requiredCapability: CYCLES_PUBLISH, tenancy: 'ORG' },
      handler: (req) => publishCycle(parseParams(CycleIdParam, req).cycleId, now(), actor()),
    },
    {
      method: 'get',
      path: '/:cycleId/tasks',
      summary: 'Scheduled work this cycle has enqueued',
      policy: { requiredCapability: CYCLES_READ, tenancy: 'ORG' },
      handler: (req) => listCycleTasks(parseParams(CycleIdParam, req).cycleId),
    },
    {
      method: 'get',
      path: '/:cycleId/participations',
      summary: 'Operators participating in a cycle',
      policy: { requiredCapability: CYCLES_READ, tenancy: 'ORG' },
      handler: (req) =>
        listParticipations(
          parseParams(CycleIdParam, req).cycleId,
          parseQuery(ParticipationListQuery, req),
        ),
    },
    {
      method: 'post',
      path: '/:cycleId/participations',
      summary: 'Add an operator to a cycle',
      status: 201,
      policy: { requiredCapability: CYCLES_PARTICIPATIONS_WRITE, tenancy: 'ORG' },
      handler: (req) =>
        addParticipation(
          parseParams(CycleIdParam, req).cycleId,
          parseBody(CreateParticipation, req),
          now(),
        ),
    },
    {
      method: 'get',
      path: '/:cycleId/participations/:participationId',
      summary: 'Read one participation',
      policy: { requiredCapability: CYCLES_READ, tenancy: 'ORG' },
      handler: (req) => {
        const { cycleId, participationId } = parseParams(ParticipationParams, req);
        return readParticipation(cycleId, participationId);
      },
    },
    {
      method: 'delete',
      path: '/:cycleId/participations/:participationId',
      summary: 'Remove an operator from a cycle that has not opened yet',
      policy: { requiredCapability: CYCLES_PARTICIPATIONS_WRITE, tenancy: 'ORG' },
      handler: (req) => {
        const { cycleId, participationId } = parseParams(ParticipationParams, req);
        return removeParticipation(cycleId, participationId);
      },
    },
    {
      method: 'post',
      path: '/:cycleId/participations/:participationId/withdraw',
      summary: 'Withdraw an operator from a cycle that has already opened',
      policy: { requiredCapability: CYCLES_PARTICIPATIONS_WRITE, tenancy: 'ORG' },
      handler: (req) => {
        const { cycleId, participationId } = parseParams(ParticipationParams, req);
        const { reason } = parseBody(WithdrawParticipation, req);
        return withdrawParticipation(cycleId, participationId, reason, now());
      },
    },
  ],
});
