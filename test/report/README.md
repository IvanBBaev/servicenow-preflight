# test/report/

Home for the report-formatter test suites: one `*.test.js` per formatter in
`src/report/` (`github`, `junit`, `markdown`, `sarif`). They are picked up by the
recursive test glob `test/**/*.test.js`.

Tests import the COMPILED output, e.g.:

```js
import { formatJUnit } from "../../build/report/junit.js";
import { formatSarif } from "../../build/report/sarif.js";
```

Build (`npm run build`) before running tests.
