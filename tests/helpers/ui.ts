import { Writable } from 'node:stream';
import { Ui } from '@upgradelab/cli';

class MemoryStream extends Writable {
  private readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join('');
  }
}

export interface CapturedUi {
  readonly ui: Ui;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export function createCapturedUi(json = false): CapturedUi {
  const out = new MemoryStream();
  const err = new MemoryStream();
  const ui = new Ui({ json, color: false, stdout: out, stderr: err });
  return {
    ui,
    stdout: () => out.text(),
    stderr: () => err.text(),
  };
}
