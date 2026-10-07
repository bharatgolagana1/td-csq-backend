import { model, Schema, type Types } from 'mongoose';

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserDoc {
  _id: Types.ObjectId;
  /** Keycloak subject; null until the first sign-in links the account by e-mail. */
  keycloakSub: string | null;
  email: string;
  name: string;
  phone: string | null;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<UserDoc>(
  {
    keycloakSub: { type: String, default: null },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: null },
    status: { type: String, enum: USER_STATUSES, required: true, default: 'INVITED' },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'users' },
);

schema.index({ keycloakSub: 1 }, { unique: true, partialFilterExpression: { keycloakSub: { $type: 'string' } } });
schema.index({ status: 1 });

export const UserModel = model<UserDoc>('User', schema);
