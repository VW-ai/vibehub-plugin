#!/usr/bin/env node
import { TICKET, run } from "./_dispatch.mjs";
await run("ticket", TICKET, process.argv.slice(2));
