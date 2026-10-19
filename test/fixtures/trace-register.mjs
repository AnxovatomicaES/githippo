// Preload for tests: records every module the process resolves (see test/report6.test.js).
import { register } from "node:module";
register("./trace-resolve.mjs", import.meta.url);
