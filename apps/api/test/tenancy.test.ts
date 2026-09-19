import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { CsqError } from '@csq/contracts';
import { defineTenantModel, TenantRepo } from '../src/kernel/tenancy.js';
import { runAsPrincipal, runSystem } from '../src/kernel/requestContext.js';
import { newId } from '../src/kernel/ids.js';
import { closeDatabase, openDatabase, principal, silentLog } from './mongo.js';

interface WidgetDoc {
  _id: string;
  name: string;
  count: number;
}

const WidgetModel = defineTenantModel<WidgetDoc>({
  name: 'TenancyTestWidget',
  definition: {
    name: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
  },
});

const widgets = new TenantRepo<WidgetDoc>(WidgetModel);

const ORG_A = newId();
const ORG_B = newId();
const alice = principal('alice', ORG_A);
const mallory = principal('mallory', ORG_B);

function asA<T>(fn: () => T): T {
  return runAsPrincipal({ requestId: newId(), principal: alice, orgId: ORG_A }, fn);
}

function asB<T>(fn: () => T): T {
  return runAsPrincipal({ requestId: newId(), principal: mallory, orgId: ORG_B }, fn);
}

describe('tenancy plugin', () => {
  beforeAll(async () => {
    await openDatabase();
    await WidgetModel.syncIndexes();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(async () => {
    await mongoose.connection.collection(WidgetModel.collection.name).deleteMany({});
  });

  it('stamps the scope organisation on a document saved through .save()', async () => {
    const created = await asA(() => widgets.create({ name: 'alpha' }));
    expect(created.orgId).toBe(ORG_A);
  });

  it('hides another organisation document from find', async () => {
    await asA(() => widgets.create({ name: 'alpha' }));

    const mine = await asA(() => widgets.find({}).lean().exec());
    const theirs = await asB(() => widgets.find({}).lean().exec());

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it('returns null rather than 403 when another organisation document is fetched by id', async () => {
    const created = await asA(() => widgets.create({ name: 'alpha' }));

    const found = await asB(() => widgets.findById(created._id).lean().exec());

    expect(found).toBeNull();
  });

  it('refuses a filter that names another organisation, as a not found', async () => {
    await asA(() => widgets.create({ name: 'alpha' }));

    await expect(
      asB(() => WidgetModel.find({ orgId: ORG_A }).lean().exec()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not update, delete or count across organisations', async () => {
    const created = await asA(() => widgets.create({ name: 'alpha', count: 1 }));

    const updated = await asB(() =>
      widgets.findOneAndUpdate({ _id: created._id }, { $set: { count: 99 } }).lean().exec(),
    );
    const deleted = await asB(() => widgets.deleteOne({ _id: created._id }));
    const counted = await asB(() => widgets.countDocuments({}));
    const distinct = await asB(() => WidgetModel.distinct('name').exec());

    expect(updated).toBeNull();
    expect(deleted.deletedCount).toBe(0);
    expect(counted).toBe(0);
    expect(distinct).toEqual([]);

    const survivor = await asA(() => widgets.findById(created._id).lean().exec());
    expect(survivor?.count).toBe(1);
  });

  it('confines an aggregate to the scope organisation', async () => {
    await asA(() => widgets.create({ name: 'alpha', count: 5 }));
    await asB(() => widgets.create({ name: 'beta', count: 7 }));

    const totals = await asB(() =>
      widgets.aggregate<{ _id: null; total: number }>([
        { $group: { _id: null, total: { $sum: '$count' } } },
      ]).exec(),
    );

    expect(totals[0]?.total).toBe(7);
  });

  it('stamps insertMany and confines bulkWrite', async () => {
    await asA(() => WidgetModel.insertMany([{ name: 'one' }, { name: 'two' }]));
    const mine = await asA(() => widgets.find({}).lean().exec());
    expect(mine).toHaveLength(2);

    await asB(() =>
      WidgetModel.bulkWrite([{ updateMany: { filter: {}, update: { $set: { count: 42 } } } }]),
    );

    const untouched = await asA(() => widgets.find({}).lean().exec());
    expect(untouched.every((w) => w.count === 0)).toBe(true);
  });

  it('refuses a document that arrives already owned by another organisation', async () => {
    await expect(
      asB(async () => {
        const doc = new WidgetModel({ name: 'smuggled', orgId: ORG_A });
        await doc.save();
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses every query path when there is no request context at all', async () => {
    await expect(widgets.find({}).exec()).rejects.toBeInstanceOf(CsqError);
    await expect(widgets.create({ name: 'orphan' })).rejects.toBeInstanceOf(CsqError);
  });

  it('refuses estimatedDocumentCount, which cannot be tenant filtered', async () => {
    await expect(asA(() => WidgetModel.estimatedDocumentCount().exec())).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('lets a recorded system scope read across organisations', async () => {
    await asA(() => widgets.create({ name: 'alpha' }));
    await asB(() => widgets.create({ name: 'beta' }));

    const all = await runSystem({ reason: 'test: cross tenant read', log: silentLog }, () =>
      WidgetModel.find({}).lean().exec(),
    );

    expect(all).toHaveLength(2);
  });

  it('refuses a system scope whose reason explains nothing', () => {
    expect(() => runSystem({ reason: 'because', log: silentLog }, () => undefined)).toThrow(CsqError);
  });

  it('makes passing an organisation id explicitly a compile error', async () => {
    await asA(() => widgets.create({ name: 'alpha' }));
    // @ts-expect-error orgId is never on a TenantRepo filter: the plugin owns it
    const attempted = await asA(() => widgets.find({ orgId: ORG_A }).lean().exec());
    expect(attempted).toHaveLength(1);
  });
});
