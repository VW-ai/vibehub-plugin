function statusCode(error) {
  const value = error?.statusCode ?? error?.status ?? error?.response?.status;
  return Number.isInteger(value) ? value : null;
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  if (!headers || typeof headers !== 'object') return null;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1] ?? null;
}

function retryAfterMs(error, now) {
  const headers = error?.responseHeaders ?? error?.response?.headers ?? error?.headers;
  const value = headerValue(headers, 'retry-after');
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - now()) : null;
}

function transient(error) {
  const status = statusCode(error);
  return status === 429 || (status !== null && status >= 500 && status <= 599);
}

function boundedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(boundedError('judge_aborted', 'Judge request aborted'));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(boundedError('judge_aborted', 'Judge request aborted'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export class ResilientJudge {
  constructor(delegate, {
    minIntervalMs = 2500,
    maxAttempts = 3,
    baseDelayMs = 2000,
    maxDelayMs = 10_000,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = {}) {
    if (!delegate?.descriptor || typeof delegate.evaluate !== 'function') throw new Error('ResilientJudge needs a delegate');
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new Error('Invalid request interval');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('Invalid retry attempt count');
    this.delegate = delegate;
    this.minIntervalMs = minIntervalMs;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.now = now;
    this.sleep = sleep;
    this.lastStartedAt = null;
    this.stats = { requests: 0, retries: 0, rate_limited: 0, transient_failures: 0, wait_ms: 0 };
    this.semanticDescriptor = delegate.semanticDescriptor ?? delegate.descriptor;
    this.descriptor = {
      ...delegate.descriptor,
      request_spacing_ms: minIntervalMs,
      retry_policy: { max_attempts: maxAttempts, base_delay_ms: baseDelayMs, max_delay_ms: maxDelayMs, statuses: [429, '5xx'] },
    };
  }

  async wait(ms, signal) {
    if (ms <= 0) return;
    this.stats.wait_ms += ms;
    await this.sleep(ms, signal);
    if (signal?.aborted) throw boundedError('judge_aborted', 'Judge request aborted');
  }

  async pace(signal) {
    if (this.lastStartedAt !== null) {
      await this.wait(Math.max(0, this.minIntervalMs - (this.now() - this.lastStartedAt)), signal);
    }
    this.lastStartedAt = this.now();
  }

  async evaluate(input, { signal } = {}) {
    if (typeof this.delegate.requiresNetwork === 'function' && !this.delegate.requiresNetwork(input)) {
      return this.delegate.evaluate(input, { signal });
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (signal?.aborted) throw boundedError('judge_aborted', 'Judge request aborted');
      await this.pace(signal);
      this.stats.requests++;
      try {
        return await this.delegate.evaluate(input, { signal });
      } catch (error) {
        if (!transient(error)) throw boundedError('judge_provider_unavailable', 'Judge provider request failed');
        const status = statusCode(error);
        if (status === 429) this.stats.rate_limited++;
        else this.stats.transient_failures++;
        if (attempt === this.maxAttempts) {
          throw boundedError('judge_retry_exhausted', 'Judge transient retry budget exhausted');
        }
        this.stats.retries++;
        const exponential = this.baseDelayMs * 2 ** (attempt - 1);
        const requested = retryAfterMs(error, this.now) ?? exponential;
        await this.wait(Math.min(this.maxDelayMs, Math.max(exponential, requested)), signal);
      }
    }
    throw boundedError('judge_retry_exhausted', 'Judge transient retry budget exhausted');
  }

  snapshot() {
    return { ...this.stats };
  }
}
