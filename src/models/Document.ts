import { Schema, model, type Types } from 'mongoose';
import { DOCUMENT_OWNER_TYPES, DOCUMENT_STATUS, DOCUMENT_TYPES, type DocumentType } from '../config/constants';

/**
 * Compliance documents for vehicles AND drivers (the manual's `vehicleDocuments`,
 * generalized so driver licences / Hazchem certificates get the same reminders).
 * File bytes live in private storage; only metadata and the object key live here.
 */
export interface IDocument {
  _id: Types.ObjectId;
  ownerType: (typeof DOCUMENT_OWNER_TYPES)[number];
  ownerId: Types.ObjectId;
  documentType: DocumentType;
  documentNumber?: string;
  issueDate?: Date | null;
  expiryDate?: Date | null; // stored as 00:00 business-timezone of the expiry day, in UTC
  storageKey?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  checksum?: string;
  status: (typeof DOCUMENT_STATUS)[number];
  replacedById?: Types.ObjectId | null;
  replaceReason?: string;
  notes?: string;
  uploadedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DocumentSchema = new Schema<IDocument>(
  {
    ownerType: { type: String, enum: DOCUMENT_OWNER_TYPES, required: true },
    ownerId: { type: Schema.Types.ObjectId, required: true },
    documentType: { type: String, enum: DOCUMENT_TYPES, required: true },
    documentNumber: { type: String, trim: true, maxlength: 60 },
    issueDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },
    storageKey: { type: String, select: false },
    fileName: { type: String, maxlength: 160 },
    mimeType: String,
    sizeBytes: Number,
    checksum: String,
    status: { type: String, enum: DOCUMENT_STATUS, default: 'active' },
    replacedById: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
    replaceReason: { type: String, trim: true, maxlength: 300 },
    notes: { type: String, trim: true, maxlength: 1000 },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, collection: 'documents' },
);
DocumentSchema.index({ ownerType: 1, ownerId: 1, documentType: 1, status: 1 });
DocumentSchema.index({ status: 1, expiryDate: 1 });
DocumentSchema.index({ ownerId: 1, checksum: 1 });

export const ComplianceDocument = model<IDocument>('Document', DocumentSchema);
