import { model, Schema, type Types } from 'mongoose';

/** A head of the survey (Infrastructure, Security, …); `weightPct` is null unless the version weights its categories. */
export interface CategoryDoc {
  _id: Types.ObjectId;
  surveyId: Types.ObjectId;
  code: string;
  name: string;
  order: number;
  weightPct: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<CategoryDoc>(
  {
    surveyId: { type: Schema.Types.ObjectId, ref: 'Survey', required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    order: { type: Number, required: true, default: 0 },
    weightPct: { type: Number, default: null, min: 0, max: 100 },
  },
  { timestamps: true, collection: 'categories' },
);

schema.index({ surveyId: 1, code: 1 }, { unique: true });
schema.index({ surveyId: 1, order: 1 });

export const CategoryModel = model<CategoryDoc>('Category', schema);
