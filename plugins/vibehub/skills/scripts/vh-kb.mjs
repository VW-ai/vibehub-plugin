#!/usr/bin/env node
import { KB, run } from "./_dispatch.mjs";
await run("kb", KB, process.argv.slice(2));
