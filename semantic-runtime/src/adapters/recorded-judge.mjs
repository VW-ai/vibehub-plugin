import { fingerprint, judgeInputHash, requireValue } from '../core/contracts.mjs';

export class RecordedJudge {
  constructor(recording) {
    requireValue(recording?.schema_version === 1 && Array.isArray(recording.records), 'Invalid recording');
    this.records = new Map();
    for (const item of recording.records) {
      requireValue(/^[a-f0-9]{64}$/.test(item.input_hash) && !this.records.has(item.input_hash), 'Invalid or duplicate recorded input hash');
      this.records.set(item.input_hash, structuredClone(item.result));
    }
    this.descriptor = { provider: 'recording', model: 'exact-input-v1', kind: 'recorded', recording_hash: fingerprint(recording) };
  }

  async evaluate(input) {
    const result = this.records.get(judgeInputHash(input));
    if (!result) throw new Error('No result recorded for this exact input');
    return structuredClone(result);
  }
}
