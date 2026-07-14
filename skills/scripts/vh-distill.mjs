#!/usr/bin/env node
import { DISTILL, run } from "./_dispatch.mjs";
await run("distill", DISTILL, process.argv.slice(2));
