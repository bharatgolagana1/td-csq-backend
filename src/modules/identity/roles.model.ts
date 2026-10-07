import { model, Schema, type Types } from 'mongoose';

export const ROLE_SCOPES = ['PLATFORM', 'ACO', 'AIRPORT'] as const;
export type RoleScope = (typeof ROLE_SCOPES)[number];

export interface RoleDoc {
  _id: Types.ObjectId;
  code: string;
  name: string;
  description: string;
  scope: RoleScope;
  /** Seeded roles cannot be deleted; they can be renamed and their tasks edited. */
  system: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<RoleDoc>(
  {
    code: { type: String, required: true, uppercase: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    scope: { type: String, enum: ROLE_SCOPES, required: true },
    system: { type: Boolean, required: true, default: false },
  },
  { timestamps: true, collection: 'roles' },
);

export const RoleModel = model<RoleDoc>('Role', schema);
