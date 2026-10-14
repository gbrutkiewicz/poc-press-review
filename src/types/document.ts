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
