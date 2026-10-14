import type { TagCategory } from '../config/tags.js';

export type FileKind = 'pdf' | 'docx' | 'image';
export type DocumentStatus = 'pending' | 'validated' | 'error';

export interface ExtractedImage {
  imageId: string;
  buffer: Buffer; // PNG (ou format d'origine si non convertible)
  format: string; // extension du fichier stocké
  width?: number;
  height?: number;
  page?: number;
  origin: 'embedded' | 'original';
}

export interface ExtractionMetadata {
  fileSize: number;
  mimeType: string;
  pageCount?: number;
  width?: number;
  height?: number;
  title?: string;
  author?: string;
  producer?: string;
  ocr?: { used: boolean; confidence?: number; reason?: string };
  warnings: string[];
}

export interface ExtractionResult {
  kind: FileKind;
  text: string;
  images: ExtractedImage[];
  metadata: ExtractionMetadata;
  durationMs: number;
}

export interface TagScore {
  value: string;
  confidence: number; // 0..1
  matches: string[]; // extraits ayant déclenché le tag (debug / explicabilité)
  origin: 'keywords' | 'ollama' | 'keywords+ollama' | 'context' | 'fallback';
}

export type TagSet = Record<TagCategory, TagScore[]>;

export interface TaggingResult {
  tags: TagSet;
  confidence: number; // confiance globale 0..1
  requiresManualReview: boolean;
  reviewReasons: string[];
  engine: 'keywords' | 'keywords+ollama';
}

/** Tags simples (sans score) — format de validation humaine. */
export type PlainTags = Record<TagCategory, string[]>;

export interface DocumentRecord {
  documentId: string;
  filename: string;
  filePath: string;
  fileHash: string;
  kind: FileKind;
  mimeType: string;
  fileSize: number;
  pageCount: number | null;
  extractedText: string;
  metadata: ExtractionMetadata;
  tagging: TaggingResult | null;
  status: DocumentStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  images?: ImageRecord[];
  validation?: ValidationRecord | null;
}

export interface ImageRecord {
  imageId: string;
  documentId: string;
  storagePath: string;
  format: string;
  width: number | null;
  height: number | null;
  page: number | null;
  origin: 'embedded' | 'original';
  extractedAt: string;
}

export interface ValidationRecord {
  documentId: string;
  validatedTags: PlainTags;
  validatedBy: string;
  notes: string | null;
  validatedAt: string;
}

/** Événement de l'historique de validation. */
export interface ValidationEvent {
  id: number;
  documentId: string;
  action: 'validate' | 'reopen';
  tags: PlainTags; // tags validés (pour reopen : instantané au moment de la remise en attente)
  by: string;
  notes: string | null; // notes de validation, ou motif de remise en attente
  at: string;
}

/** Comparaison proposition automatique (tags pré-cochés) ↔ tags validés. */
export type TagDiff = Record<import('../config/tags.js').TagCategory, { kept: string[]; added: string[]; removed: string[] }>;

export interface ValidatedListItem {
  documentId: string;
  filename: string;
  kind: FileKind;
  fileSize: number;
  pageCount: number | null;
  imageCount: number;
  autoConfidence: number | null;
  textPreview: string;
  scannedAt: string;
  validation: ValidationRecord;
  autoTagging?: TaggingResult | null;
}
