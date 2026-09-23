import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, fingerprint, judgeInputHash, validateDecision } from '../../core/contracts.mjs';

function boundedTelemetry(input) {
  if (!input || typeof input !== 'object') return null;
  const number = key => Number.isFinite(input[key]) && input[key] >= 0 ? input[key] : null;
  const provider = typeof input.final_provider === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(input.final_provider)
    ? input.final_provider : 'unknown';
  return {
    final_provider: provider,
    cost_usd: number('cost_usd'),
    input_tokens: number('input_tokens'),
    output_tokens: number('output_tokens'),
    total_tokens: number('total_tokens'),
  };
}

function add(sum, value) {
  return value === null ? sum : sum + value;
}

export class CachedJudge {
  constructor(delegate, { path } = {}) {
    if (!delegate?.descriptor || typeof delegate.evaluate !== 'function') throw new Error('CachedJudge needs a delegate');
    if (typeof path !== 'string' || path.length === 0) throw new Error('CachedJudge needs a cache path');
    this.delegate = delegate;
    this.path = path;
    this.semanticDescriptor = delegate.semanticDescriptor ?? delegate.descriptor;
    this.descriptor = { ...delegate.descriptor, cache_strategy: 'successful-decision-input-hash-v1' };
    this.cache = new Map();
    this.stats = { cache_hits: 0, cache_misses: 0, entries_written: 0 };
    this.observed = { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, provider_routes: {} };
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        if (typeof entry.key !== 'string' || !entry.result) throw new Error('Invalid judge cache entry');
        this.cache.set(entry.key, entry);
      }
    }
  }

  key(input) {
    return fingerprint({ judge: this.semanticDescriptor, input_hash: judgeInputHash(input) });
  }

  observe(telemetry) {
    if (!telemetry) return;
    this.observed.calls++;
    this.observed.cost_usd = add(this.observed.cost_usd, telemetry.cost_usd);
    this.observed.input_tokens = add(this.observed.input_tokens, telemetry.input_tokens);
    this.observed.output_tokens = add(this.observed.output_tokens, telemetry.output_tokens);
    this.observed.total_tokens = add(this.observed.total_tokens, telemetry.total_tokens);
    this.observed.provider_routes[telemetry.final_provider] = (this.observed.provider_routes[telemetry.final_provider] ?? 0) + 1;
  }

  async evaluate(input, options) {
    const key = this.key(input);
    const cached = this.cache.get(key);
    if (cached) {
      const result = validateDecision(cached.result, input);
      const telemetry = boundedTelemetry(cached.telemetry);
      this.stats.cache_hits++;
      this.observe(telemetry);
      return { ...result, telemetry };
    }
    this.stats.cache_misses++;
    const raw = await this.delegate.evaluate(input, options);
    const result = validateDecision(raw, input);
    const telemetry = boundedTelemetry(raw.telemetry);
    const entry = { key, result, telemetry };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${canonical(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.cache.set(key, entry);
    this.stats.entries_written++;
    this.observe(telemetry);
    return { ...result, telemetry };
  }

  snapshot() {
    return {
      ...this.stats,
      cached_entries: this.cache.size,
      observed: structuredClone(this.observed),
      transport: typeof this.delegate.snapshot === 'function' ? this.delegate.snapshot() : null,
    };
  }
}
