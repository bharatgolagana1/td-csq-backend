import { model, Schema, type Types } from 'mongoose';

/**
 * One operator's share of an airport, either the current default
 * (`cycleId: null`) or a snapshot copied when a cycle is published.
 * Per airport + cycle the shares must total 100; the service validates the set.
 */
export interface MarketShareDoc {
  _id: Types.ObjectId;
  airportId: Types.ObjectId;
  acoId: Types.ObjectId;
  cycleId: Types.ObjectId | null;
  sharePct: number;
  setBy: Types.ObjectId | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<MarketShareDoc>(
  {
    airportId: { type: Schema.Types.ObjectId, ref: 'Airport', required: true },
    acoId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    cycleId: { type: Schema.Types.ObjectId, ref: 'Cycle', default: null },
    sharePct: { type: Number, required: true, min: 0, max: 100 },
    setBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: null },
  },
  { timestamps: true, collection: 'market_shares' },
);

schema.index({ airportId: 1, cycleId: 1, acoId: 1 }, { unique: true });
schema.index({ acoId: 1, cycleId: 1 });

export const MarketShareModel = model<MarketShareDoc>('MarketShare', schema);
