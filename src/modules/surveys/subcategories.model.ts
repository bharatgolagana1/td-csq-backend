import { model, Schema, type Types } from 'mongoose';

/** An optional grouping inside a category; questions may sit directly under a category instead. */
export interface SubcategoryDoc {
  _id: Types.ObjectId;
  surveyId: Types.ObjectId;
  categoryId: Types.ObjectId;
  code: string;
  name: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<SubcategoryDoc>(
  {
    surveyId: { type: Schema.Types.ObjectId, ref: 'Survey', required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    order: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, collection: 'subcategories' },
);

schema.index({ surveyId: 1, code: 1 }, { unique: true });
schema.index({ surveyId: 1, categoryId: 1, order: 1 });

export const SubcategoryModel = model<SubcategoryDoc>('Subcategory', schema);
