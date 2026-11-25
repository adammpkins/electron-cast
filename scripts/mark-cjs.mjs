// The package is "type": "module", so the CommonJS build in dist/cjs needs its own package.json to be loaded as CJS.
import { writeFileSync } from "node:fs";

writeFileSync(new URL("../dist/cjs/package.json", import.meta.url), '{ "type": "commonjs" }\n');
