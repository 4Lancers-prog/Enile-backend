import { Schema } from 'mongoose';

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  stateCode?: string;
  pincode?: string;
}

export const AddressSchema = new Schema<Address>(
  {
    line1: { type: String, trim: true, maxlength: 200 },
    line2: { type: String, trim: true, maxlength: 200 },
    city: { type: String, trim: true, maxlength: 80 },
    state: { type: String, trim: true, maxlength: 80 },
    stateCode: { type: String, trim: true, maxlength: 2 },
    pincode: { type: String, trim: true, maxlength: 6 },
  },
  { _id: false },
);

/** A privately stored upload (receipt, slip). Bytes live in storage; the key is never sent to clients. */
export interface FileRef {
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  uploadedAt: Date;
}

export const FileRefSchema = new Schema<FileRef>(
  {
    storageKey: { type: String, required: true },
    fileName: { type: String, maxlength: 160 },
    mimeType: String,
    sizeBytes: Number,
    checksum: String,
    uploadedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);
