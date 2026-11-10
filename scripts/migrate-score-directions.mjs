import mongoose from 'mongoose';

const apply = process.argv.includes('--apply');

const acknowledgedDatabase = process.argv
  .find((arg) => arg.startsWith('--database='))
  ?.slice('--database='.length);

if (process.env.NODE_ENV !== 'development') {
  throw new Error(
    'Migration is allowed only in development',
  );
}

if (!process.env.MONGO_URI) {
  throw new Error('MONGO_URI is missing');
}

const plans = [
  {
    collection: 'scores',
    old: {
      cycleId: 1,
      acoId: 1,
      surveyType: 1,
      level: 1,
      refId: 1,
    },
    next: {
      cycleId: 1,
      acoId: 1,
      surveyType: 1,
      direction: 1,
      level: 1,
      refId: 1,
    },
  },
  {
    collection: 'airport_scores',
    old: {
      cycleId: 1,
      airportId: 1,
      surveyType: 1,
      level: 1,
      refId: 1,
    },
    next: {
      cycleId: 1,
      airportId: 1,
      surveyType: 1,
      direction: 1,
      level: 1,
      refId: 1,
    },
  },
];

function sameKeys(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

try {
  await mongoose.connect(process.env.MONGO_URI);

  const db = mongoose.connection.db;

  if (!db) {
    throw new Error('Database connection failed');
  }

  console.log('Database:', db.databaseName);
  console.log('Mode:', apply ? 'APPLY' : 'DRY RUN');

  if (apply && acknowledgedDatabase !== db.databaseName) {
    throw new Error(
      `Confirm database with --database=${db.databaseName}`,
    );
  }

  for (const plan of plans) {
    const collection = db.collection(plan.collection);

    const missing = await collection.countDocuments({
      direction: null,
    });

    const indexes = await collection.indexes();

    const oldIndex = indexes.find(
      (index) =>
        index.unique &&
        sameKeys(index.key, plan.old),
    );

    const newIndex = indexes.find(
      (index) =>
        index.unique &&
        sameKeys(index.key, plan.next),
    );

    console.log({
      collection: plan.collection,
      missingDirection: missing,
      oldIndex: oldIndex?.name ?? null,
      newIndex: newIndex?.name ?? null,
    });

    if (!apply) continue;

    await collection.updateMany(
      { direction: null },
      { $set: { direction: 'SINGLE' } },
    );

    if (!newIndex) {
      await collection.createIndex(plan.next, {
        unique: true,
      });
    }

    // Verify the replacement index exists before removing the old one.
    const verified = await collection.indexes();

    const replacementExists = verified.some(
      (index) =>
        index.unique &&
        sameKeys(index.key, plan.next),
    );

    if (!replacementExists) {
      throw new Error(
        `New unique index missing for ${plan.collection}`,
      );
    }

    if (oldIndex?.name) {
      await collection.dropIndex(oldIndex.name);
    }

    console.log(`Migrated ${plan.collection}`);
  }
} finally {
  await mongoose.disconnect();
}
