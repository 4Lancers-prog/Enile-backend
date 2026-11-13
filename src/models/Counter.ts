import { Schema, model } from 'mongoose';

/** Atomic sequences for company codes, quotation and trip numbers (manual 4.3). */
interface ICounter {
  _id: string;
  seq: number;
}
const CounterSchema = new Schema<ICounter>({ _id: { type: String, required: true }, seq: { type: Number, default: 0 } }, { versionKey: false });
export const Counter = model<ICounter>('Counter', CounterSchema);

export async function nextSequence(key: string): Promise<number> {
  const doc = await Counter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, new: true, lean: true });
  return doc!.seq;
}
