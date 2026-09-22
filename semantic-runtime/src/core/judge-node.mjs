import { FAMILIES, fingerprint } from './contracts.mjs';

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const configuration = {
  type: 'object', additionalProperties: false,
  required: ['family', 'question_id', 'question_version', 'question_text', 'confidence_threshold', 'impact'],
  properties: {
    family: { type: 'string', enum: [...FAMILIES] },
    question_id: { type: 'string', maxLength: 200 },
    question_version: { type: 'string', maxLength: 200 },
    question_text: { type: 'string', maxLength: 4096 },
    confidence_threshold: { type: 'number', minimum: 0, maximum: 1 },
    impact: { type: 'string', enum: ['normal', 'high'] },
  },
};
const operation = {
  id: 'semantic-judge', version: '1', type: 'judge',
  inputs: { event: 'event_ref', selection: 'signal_ref' },
  outputs: { relevant: 'boolean', confidence: 'number', targets: 'candidates_ref', decision: 'signal_ref' },
  error_outputs: { error: 'error_ref' }, branches: ['negative', 'positive', 'uncertain'], branch_mode: 'exclusive',
  config_schema: configuration,
};
// This descriptor identifies the selected-input v1 operation contract, not a
// claim that the legacy full-snapshot Policy executor supports model nodes.
export const JUDGE_NODE_OPERATION = freeze({ ...operation, implementation_hash: `sha256:${fingerprint(['selected-judge-node-v1', operation])}` });
export const JUDGE_DECISION_SCHEMA = freeze({ id: 'semantic-judge-boolean-targets', version: 1 });
