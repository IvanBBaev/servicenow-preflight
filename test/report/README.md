# test/report/

Home for the report-formatter test suites. Downstream agents implementing the
`formatJUnit` / `formatSarif` stubs (`src/report/junit.ts`, `src/report/sarif.ts`)
add their `*.test.js` files here — they are picked up by the recursive test glob
`test/**/*.test.js`.

Tests import the COMPILED output, e.g.:

```js
import { formatJUnit } from "../../build/report/junit.js";
import { formatSarif } from "../../build/report/sarif.js";
```

Build (`npm run build`) before running tests.
