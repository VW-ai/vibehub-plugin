// Separate process, intentionally killed after it durably starts one attempt.
process.once('message', async ({ url, token }) => {
  const call = async (action, input) => {
    const response = await fetch(`${url}/jobs/${action}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error('synthetic_executor_rejected'); return response.json();
  };
  try {
    const claim = await call('claim', { attempt_id: 'attempt-crashed' });
    process.send({ type: 'claimed' });
    const attempt = claim.state.attempts.at(-1);
    const start = await call('start', { expected_revision: claim.state.revision, attempt_id: attempt.attempt_id, fencing_token: attempt.fencing_token });
    process.send({ type: 'started', state: start.state });
    setInterval(() => {}, 1000);
  } catch { process.send({ type: 'failed' }); process.exitCode = 1; }
});
