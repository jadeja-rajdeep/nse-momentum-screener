/* ============================================================================
   indicator-query.js — Advance Query engine for indicator-based filtering.
   ----------------------------------------------------------------------------
   Grammar (Chartink-style):

     query      := orExpr
     orExpr     := andExpr (OR andExpr)*
     andExpr    := notExpr (AND notExpr)*
     notExpr    := NOT notExpr | comparison
     comparison := arith (COMPOP arith)?          // no compop => truthy check
     arith      := term ((+|-) term)*
     term       := factor ((*|/) factor)*
     factor     := NUMBER
                 | INDEXED_FIELD                   // e.g. supertrend_21_9[0]
                 | ( orExpr )                       // grouping — works at any level,
                                                     // so (supertrend_21_9[0] * 0.25) is
                                                     // valid inside a comparison too
                 | (+|-) factor                     // unary sign

   Indexed field: IDENT '[' INTEGER ']'
     - IDENT is either an OHLCV key (open/high/low/close/volume) or one of the
       indicator keys reported by indicator-worker.js's DONE message.
     - INTEGER is the "bars ago" offset: 0 = latest/today, 1 = one bar back, etc.
       Resolved as: series[series.length - 1 - offset].

   Example queries this supports:
     supertrend_21_9[0] * 0.25 >= close[0] - close[1]
     (ema_50_close[0] > ema_200_close[0]) AND rsi_14[0] > 55
     NOT (close[0] < supertrend_21_9[0])
   ========================================================================= */

const OHLCV_KEYS = new Set(["open", "high", "low", "close", "volume"]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
// Token kinds: NUMBER, IDENT_INDEXED ({name, index}), OP (+-*/), COMPOP,
// LOGIC (AND/OR/NOT), LPAREN, RPAREN
function iqTokenize(text) {
    const tokens = [];
    let i = 0;
    const n = text.length;

    const isIdentStart = (c) => /[A-Za-z_]/.test(c);
    const isIdentChar = (c) => /[A-Za-z0-9_.]/.test(c);
    const isDigit = (c) => /[0-9]/.test(c);

    while (i < n) {
        const c = text[i];

        if (/\s/.test(c)) { i++; continue; }

        // Numbers (including decimals, no exponent needed here)
        if (isDigit(c) || (c === "." && isDigit(text[i + 1]))) {
            let start = i;
            while (i < n && isDigit(text[i])) i++;
            if (text[i] === ".") {
                i++;
                while (i < n && isDigit(text[i])) i++;
            }
            tokens.push({ type: "NUMBER", value: parseFloat(text.slice(start, i)) });
            continue;
        }

        // Identifiers / keywords / indexed fields
        if (isIdentStart(c)) {
            let start = i;
            while (i < n && isIdentChar(text[i])) i++;
            const word = text.slice(start, i);
            const upper = word.toUpperCase();

            if (upper === "AND" || upper === "OR" || upper === "NOT") {
                tokens.push({ type: "LOGIC", value: upper });
                continue;
            }

            // Skip whitespace between name and optional '['
            let j = i;
            while (j < n && /\s/.test(text[j])) j++;

            if (text[j] === "[") {
                j++;
                let k = j;
                while (k < n && /\s/.test(text[k])) k++;
                const idxStart = k;
                let sign = "";
                if (text[k] === "-") { sign = "-"; k++; }
                const digitsStart = k;
                while (k < n && isDigit(text[k])) k++;
                if (k === digitsStart) {
                    throw new Error(`Expected an integer index inside "${word}[...]"`);
                }
                let m = k;
                while (m < n && /\s/.test(text[m])) m++;
                if (text[m] !== "]") {
                    throw new Error(`Missing closing "]" for "${word}[...]"`);
                }
                const index = parseInt(sign + text.slice(digitsStart, k), 10);
                tokens.push({ type: "FIELD", name: word.toLowerCase(), index });
                i = m + 1;
                continue;
            }

            throw new Error(`Field "${word}" must be indexed, e.g. "${word}[0]"`);
        }

        if (c === "(") { tokens.push({ type: "LPAREN" }); i++; continue; }
        if (c === ")") { tokens.push({ type: "RPAREN" }); i++; continue; }
        if (c === "+" || c === "-" || c === "*" || c === "/") {
            tokens.push({ type: "OP", value: c }); i++; continue;
        }

        // Comparison operators (check 2-char forms first)
        const two = text.slice(i, i + 2);
        if (two === ">=" || two === "<=" || two === "!=" || two === "<>") {
            tokens.push({ type: "COMPOP", value: two === "<>" ? "!=" : two });
            i += 2; continue;
        }
        if (c === ">" || c === "<" || c === "=") {
            tokens.push({ type: "COMPOP", value: c === "=" ? "==" : c });
            i++; continue;
        }

        throw new Error(`Unexpected character "${c}" at position ${i}`);
    }

    return tokens;
}

// ---------------------------------------------------------------------------
// Parser — builds a closure tree: (ctx) => number | boolean
// ctx = { resolve(name, index) => number|undefined }
// ---------------------------------------------------------------------------
function iqParse(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const expect = (type, msg) => {
        const t = next();
        if (!t || t.type !== type) throw new Error(msg || `Expected ${type}`);
        return t;
    };

    function parseOr() {
        let left = parseAnd();
        while (peek() && peek().type === "LOGIC" && peek().value === "OR") {
            next();
            const right = parseAnd();
            const l = left, r = right;
            left = (ctx) => Boolean(l(ctx)) || Boolean(r(ctx));
        }
        return left;
    }

    function parseAnd() {
        let left = parseNot();
        while (peek() && peek().type === "LOGIC" && peek().value === "AND") {
            next();
            const right = parseNot();
            const l = left, r = right;
            left = (ctx) => Boolean(l(ctx)) && Boolean(r(ctx));
        }
        return left;
    }

    function parseNot() {
        if (peek() && peek().type === "LOGIC" && peek().value === "NOT") {
            next();
            const f = parseNot();
            return (ctx) => !f(ctx);
        }
        return parseComparison();
    }

    function parseComparison() {
        const left = parseArith();
        if (peek() && peek().type === "COMPOP") {
            const op = next().value;
            const right = parseArith();
            return (ctx) => {
                const a = left(ctx), b = right(ctx);
                if (a === undefined || b === undefined) return false; // missing data => no match
                switch (op) {
                    case "==": return a === b;
                    case "!=": return a !== b;
                    case ">": return a > b;
                    case "<": return a < b;
                    case ">=": return a >= b;
                    case "<=": return a <= b;
                }
                return false;
            };
        }
        // Bare arithmetic expression used as a condition (e.g. just "close[0]")
        // is treated as a truthy check (non-zero, defined).
        return (ctx) => {
            const v = left(ctx);
            return v !== undefined && v !== 0 && !Number.isNaN(v);
        };
    }

    function parseArith() {
        let left = parseTerm();
        while (peek() && peek().type === "OP" && (peek().value === "+" || peek().value === "-")) {
            const op = next().value;
            const right = parseTerm();
            const l = left, r = right;
            left = (ctx) => {
                const a = l(ctx), b = r(ctx);
                if (a === undefined || b === undefined) return undefined;
                return op === "+" ? a + b : a - b;
            };
        }
        return left;
    }

    function parseTerm() {
        let left = parseFactor();
        while (peek() && peek().type === "OP" && (peek().value === "*" || peek().value === "/")) {
            const op = next().value;
            const right = parseFactor();
            const l = left, r = right;
            left = (ctx) => {
                const a = l(ctx), b = r(ctx);
                if (a === undefined || b === undefined) return undefined;
                if (op === "/" && b === 0) return undefined;
                return op === "*" ? a * b : a / b;
            };
        }
        return left;
    }

    function parseFactor() {
        const t = peek();
        if (!t) throw new Error("Unexpected end of expression");

        if (t.type === "OP" && (t.value === "+" || t.value === "-")) {
            next();
            const f = parseFactor();
            return t.value === "-" ? (ctx) => { const v = f(ctx); return v === undefined ? undefined : -v; } : f;
        }
        if (t.type === "NUMBER") {
            next();
            return () => t.value;
        }
        if (t.type === "FIELD") {
            next();
            const { name, index } = t;
            return (ctx) => ctx.resolve(name, index);
        }
        if (t.type === "LPAREN") {
            next();
            const inner = parseOr(); // allow full grouping, incl. logical, inside parens
            expect("RPAREN", 'Missing closing ")"');
            return inner;
        }
        throw new Error(`Unexpected token "${JSON.stringify(t)}"`);
    }

    if (!tokens.length) throw new Error("Empty query");
    const expr = parseOr();
    if (pos !== tokens.length) {
        throw new Error(`Unexpected token after end of expression: ${JSON.stringify(tokens[pos])}`);
    }
    return expr;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a query string into a predicate function (isin) => boolean.
 * @param {string} queryText
 * @param {object} deps
 * @param {(isin:string, key:string) => number[]|undefined} deps.getOHLCVSeries
 * @param {(isin:string, key:string) => number[]|undefined} deps.getIndicatorSeries
 * @returns {(isin:string) => boolean}
 */
function compileIndicatorQuery(queryText, deps) {
    const text = (queryText || "").trim();
    if (!text) return null;
    const tokens = iqTokenize(text);
    const predicate = iqParse(tokens);

    return function evaluate(isin) {
        const ctx = {
            resolve(name, index) {
                const series = OHLCV_KEYS.has(name)
                    ? deps.getOHLCVSeries(isin, name)
                    : deps.getIndicatorSeries(isin, name);
                if (!series || !series.length) return undefined;
                const i = series.length - 1 - index;
                if (i < 0 || i >= series.length) return undefined;
                const v = series[i];
                return typeof v === "number" && Number.isFinite(v) ? v : undefined;
            },
        };
        try {
            return Boolean(predicate(ctx));
        } catch {
            return false;
        }
    };
}

/** Validate syntax only (no data needed) — for live "✓ Valid" feedback in the UI. */
function validateIndicatorQuery(queryText) {
    const text = (queryText || "").trim();
    if (!text) return { ok: true };
    try {
        iqParse(iqTokenize(text));
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** Largest "bars ago" offset used in a query, e.g. close[5] -> 5. Used to warn when it exceeds the bars kept in memory. */
function extractIndicatorQueryMaxOffset(queryText) {
    const text = (queryText || "").trim();
    if (!text) return 0;
    let max = 0;
    iqTokenize(text).forEach((t) => { if (t.type === "FIELD" && t.index > max) max = t.index; });
    return max;
}

/** Collect every FIELD name referenced in a query (for e.g. dependency checks). */
function extractIndicatorQueryFields(queryText) {
    const text = (queryText || "").trim();
    if (!text) return [];
    const tokens = iqTokenize(text);
    const names = new Set();
    tokens.forEach((t) => { if (t.type === "FIELD") names.add(t.name); });
    return [...names];
}

// Export for both classic <script> include (main thread) and Worker context.
if (typeof module !== "undefined" && module.exports) {
    module.exports = { compileIndicatorQuery, validateIndicatorQuery, extractIndicatorQueryFields, extractIndicatorQueryMaxOffset };
} else {
    self.IndicatorQuery = { compileIndicatorQuery, validateIndicatorQuery, extractIndicatorQueryFields, extractIndicatorQueryMaxOffset };
}
