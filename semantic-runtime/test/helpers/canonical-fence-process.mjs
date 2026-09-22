import { readFileSync } from 'node:fs';
import { connect, ACTIONS } from './graph-store-fixture.mjs';
const [filePath, commandPath] = process.argv.slice(2);
const f = connect(filePath);
try {
  const context = f.issue({ actions: [...ACTIONS, 'source:invalidate'] }).context;
  f.ingress.updateSourceAccess(context, JSON.parse(readFileSync(commandPath, 'utf8')));
} finally { f.store.close(); f.authority.close(); }
