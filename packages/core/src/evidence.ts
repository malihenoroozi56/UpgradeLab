import type { EvidenceKind, EvidenceReference, Redactor } from '@upgradelab/contracts';

export interface EvidenceOptions {
  readonly maxInlineBytes?: number;
  readonly maxTotalBytes?: number;
  readonly mediaType?: string;
}

const DEFAULT_MAX_INLINE_BYTES = 16 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/**
 * In-memory evidence collector.
 *
 * Content is redacted before storage and truncated per item and in total, so a
 * chatty migration log cannot exhaust memory or bloat report artifacts.
 */
export class EvidenceCollector {
  private readonly items: EvidenceReference[] = [];
  private readonly redactor: Redactor;
  private readonly maxInlineBytes: number;
  private readonly maxTotalBytes: number;
  private storedBytes = 0;
  private counter = 0;

  constructor(redactor: Redactor, options: EvidenceOptions = {}) {
    this.redactor = redactor;
    this.maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  add(
    kind: EvidenceKind,
    description: string,
    content: string,
    options: { readonly mediaType?: string } = {},
  ): EvidenceReference {
    const redacted = this.redactor.redact(content);
    const originalBytes = Buffer.byteLength(redacted, 'utf8');
    this.counter += 1;
    const id = `ev-${this.counter}`;

    const totalRemaining = this.maxTotalBytes - this.storedBytes;
    const allowed = Math.max(0, Math.min(this.maxInlineBytes, totalRemaining));
    let inline = '';
    let truncated = false;
    if (allowed > 0) {
      const buffer = Buffer.from(redacted, 'utf8');
      if (buffer.byteLength > allowed) {
        inline = `${buffer.subarray(0, allowed).toString('utf8')}\n…[truncated ${buffer.byteLength - allowed} bytes]`;
        truncated = true;
      } else {
        inline = redacted;
      }
      this.storedBytes += Buffer.byteLength(inline, 'utf8');
    } else {
      truncated = true;
      inline = '…[evidence budget exhausted]';
    }

    const reference: EvidenceReference = {
      id,
      kind,
      description: this.redactor.redact(description),
      createdAt: new Date().toISOString(),
      bytes: originalBytes,
      truncated,
      inline,
      ...(options.mediaType ? { mediaType: options.mediaType } : {}),
    };
    this.items.push(reference);
    return reference;
  }

  all(): readonly EvidenceReference[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }
}
