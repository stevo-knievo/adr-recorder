#!/usr/bin/env node
// Node can't strip types under node_modules, so load the TypeScript CLI through jiti.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { main } = await jiti.import("../src/cli.ts");
process.exitCode = await main(process.argv.slice(2));
