import { model, Schema, type Types } from 'mongoose';

export interface AirportDoc {
  _id: Types.ObjectId;
  iata: string;
  icao: string | null;
  name: string;
  city: string;
  state: string;
  region: string;
  country: string;
  lat: number;
  lng: number;
  /** Active airports take part in cycles; the rest are reference data. */
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<AirportDoc>(
  {
    iata: { type: String, required: true, uppercase: true, trim: true, unique: true },
    icao: { type: String, default: null, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    region: { type: String, required: true, trim: true },
    country: { type: String, required: true, default: 'IN' },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    active: { type: Boolean, required: true, default: false },
  },
  { timestamps: true, collection: 'airports' },
);

schema.index({ active: 1, region: 1 });

export const AirportModel = model<AirportDoc>('Airport', schema);
