import { sharedAnswers } from './assessments.form.js';
import { AssessmentModel, type AssessmentDoc } from './assessments.model.js';

/** Run before serving requests. Archive original notes and mirror a lossless shared value.
 * Legacy combined values may exceed 2000 characters; never truncate them. The limit
 * applies to new input. Raw collection updates also preserve historical timestamps.
 */
export async function migrateSharedComments(): Promise<number> {
  let migrated = 0;
  const cursor = AssessmentModel.collection.find({ sharedCommentsVersion: { $ne: 1 } });
  for await (const raw of cursor) {
    const doc = raw as unknown as AssessmentDoc;
    const answers = doc.answers;
    const legacyDirectionalComments = answers
      .filter((answer) => typeof answer.comment === 'string')
      .map(({ questionId, direction, comment }) => ({ questionId, direction: direction ?? null, comment }));
    const result = await AssessmentModel.collection.updateOne(
      { _id: doc._id, sharedCommentsVersion: { $ne: 1 }, answers: raw['answers'] },
      { $set: { answers: sharedAnswers(answers), legacyDirectionalComments, sharedCommentsVersion: 1 } },
    );
    migrated += result.modifiedCount;
  }
  return migrated;
}
