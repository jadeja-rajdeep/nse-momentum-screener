/* ============================================================================
   data-worker.js — NSE Momentum Screener off-main-thread engine
   ----------------------------------------------------------------------------
   One script, two roles (the page spawns several copies):

   DATA role (1 copy, stateful)   — holds its own copy of the m.json rows.
     INIT         rows -> peerRankMap + groupRankMap (rank / grouping pass)
     FILTER       filter-panel state (+ advanced query) -> sorted row indices
     SORT         row indices -> sorted row indices
     GROUP_STATS  Industry / Basic Industry average-change tables
     CHAIN_COUNTS filtered-stock counts per Industry / Basic Industry
     RUN_STATES   many saved-search / preset states -> matching Codes
                  (used by the daily alert-badge pass and "Run Selected")

   CHART role (pool of copies, stateless)
     CHART        fetch data/chart/{isin}.json, compute every indicator the
                  chart settings need (reading / writing IndicatorCacheDB,
                  which works inside workers), reply with candles + results.

   Rows are never sent back to the page: replies carry row INDICES (positions
   in the array the page passed to INIT), so the page maps them onto its own
   allData. Keep the field catalogue (ADV_SPEC) in sync with ADV_FIELDS in
   index.html — INIT warns in the console if the field names drift.
   ========================================================================= */
"use strict";

let IDB_OK = true;
try {
    importScripts("indicator-db.js"); // defines IndicatorCacheDB (global const)
} catch (e) {
    IDB_OK = false;
}

// The indicator maths lives in ONE place: helper/indicator-calculators.js.
// It declares getSourceValue / calculateSMA / calculateEMA / calculateMACD /
// calculateRSI / calculateSupertrend / calculateHighestHighResistance /
// calculateTrendlinePoints as globals, so handleChart() below calls them
// directly. Never re-declare those names (let/const/function) in this file.
let CALC_OK = true;
try {
    importScripts("indicator-calculators.js");
} catch (e) {
    CALC_OK = false;
}

/* ───────────────────────────── DATA ROLE ───────────────────────────── */
let rows = [];
let N = 0;
let peerRank = new Map(); // Code -> { biRank, biTotal, biPct, indRank, indTotal, indPct }
let groupRank = new Map(); // group name -> { ind5dRank.., bi5dRank.., ... }
const colCache = new Map(); // field -> Float64Array(N) of parseFloat(row[field])

function col(key) {
    let c = colCache.get(key);
    if (!c) {
        c = new Float64Array(N);
        for (let i = 0; i < N; i++) c[i] = parseFloat(rows[i][key]);
        colCache.set(key, c);
    }
    return c;
}

function getAllIndexValues(row) {
    const v = row && row["All Index"];
    if (!v) return [];
    return String(v)
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && s !== "-" && s !== "—");
}

/* ---- ranks (verbatim port of the block that used to live in loadData) ---- */
function computeRanks() {
    peerRank = new Map();
    groupRank = new Map();

    const groupByField = (field) => {
        const groups = {};
        rows.forEach((r) => {
            const key = r[field] || "__none__";
            if (!groups[key]) groups[key] = [];
            groups[key].push(r);
        });
        return groups;
    };
    const assignRanks = (field, rankKey, totalKey, pctKey) => {
        Object.values(groupByField(field)).forEach((group) => {
            const sorted = [...group].sort((a, b) => (parseFloat(b["RS TOTAL"]) || 0) - (parseFloat(a["RS TOTAL"]) || 0));
            sorted.forEach((r, i) => {
                if (!peerRank.has(r.Code)) peerRank.set(r.Code, {});
                const entry = peerRank.get(r.Code);
                entry[rankKey] = i + 1;
                entry[totalKey] = sorted.length;
                entry[pctKey] = ((i + 1) / sorted.length) * 100;
            });
        });
    };
    assignRanks("Basic Industry", "biRank", "biTotal", "biPct");
    assignRanks("Industry", "indRank", "indTotal", "indPct");

    const rankGroupsInto = (subset, groupField, chngField, rankKey, totalKey, pctKey) => {
        const sums = {},
            counts = {};
        subset.forEach((r) => {
            const g = r[groupField] || "—";
            const v = parseFloat(r[chngField]);
            if (!isNaN(v)) {
                sums[g] = (sums[g] || 0) + v;
                counts[g] = (counts[g] || 0) + 1;
            }
        });
        const groups = Object.keys(sums).map((g) => ({ name: g, avg: counts[g] > 0 ? sums[g] / counts[g] : null }));
        const sorted = groups.filter((g) => g.avg !== null).sort((a, b) => b.avg - a.avg);
        const total = sorted.length;
        sorted.forEach((g, i) => {
            const rank = i + 1;
            if (!groupRank.has(g.name)) groupRank.set(g.name, {});
            const entry = groupRank.get(g.name);
            entry[rankKey] = rank;
            entry[totalKey] = total;
            entry[pctKey] = (rank / total) * 100;
        });
    };
    rankGroupsInto(rows, "Industry", "5 Days Chng%", "ind5dRank", "ind5dTotal", "ind5dPct");
    rankGroupsInto(rows, "Industry", "1 Month Chng%", "ind1mRank", "ind1mTotal", "ind1mPct");

    const rowsByIndustry = {};
    rows.forEach((r) => {
        (rowsByIndustry[r["Industry"] || "—"] ||= []).push(r);
    });
    Object.values(rowsByIndustry).forEach((ir) => {
        rankGroupsInto(ir, "Basic Industry", "5 Days Chng%", "bi5dRank", "bi5dTotal", "bi5dPct");
        rankGroupsInto(ir, "Basic Industry", "1 Month Chng%", "bi1mRank", "bi1mTotal", "bi1mPct");
    });
}

/* ---- sorting (same comparator as sortData() in index.html) ---- */
function rowComparator(sortCol, sortDir) {
    const peerKey = { _biRank: "biRank", _indRank: "indRank" }[sortCol];
    const grp = {
        _bi5dRank: { key: "bi5dRank", field: "Basic Industry" },
        _ind5dRank: { key: "ind5dRank", field: "Industry" },
        _bi1mRank: { key: "bi1mRank", field: "Basic Industry" },
        _ind1mRank: { key: "ind1mRank", field: "Industry" },
    }[sortCol];
    return (a, b) => {
        if (peerKey) {
            const ap = peerRank.get(a.Code),
                bp = peerRank.get(b.Code);
            return ((ap ? ap[peerKey] : Infinity) - (bp ? bp[peerKey] : Infinity)) * sortDir;
        }
        if (grp) {
            const ag = groupRank.get(a[grp.field]),
                bg = groupRank.get(b[grp.field]);
            return ((ag ? ag[grp.key] : Infinity) - (bg ? bg[grp.key] : Infinity)) * sortDir;
        }
        const av = a[sortCol],
            bv = b[sortCol];
        if (av === null || av === undefined || av === "") return 1;
        if (bv === null || bv === undefined || bv === "") return -1;
        const an = parseFloat(av),
            bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return (an - bn) * sortDir;
        return String(av).localeCompare(String(bv)) * sortDir;
    };
}

function sortIndices(idx, sortCol, sortDir) {
    const cmp = rowComparator(sortCol, sortDir);
    const arr = Array.from(idx);
    arr.sort((ia, ib) => cmp(rows[ia], rows[ib]));
    return Int32Array.from(arr);
}

/* ---- advanced query language (port of advTokenize / advParse) ---- */
// [name, type, kind, rowKey, scale]   kind: num | raw | str | special
const ADV_SPEC = [["RS_TOTAL","number","num","RS TOTAL",null],["RS_1M","number","num","1 Month RS",null],["RS_2M","number","num","2 Months RS",null],["RS_3M","number","num","3 Months RS",null],["RS_4M","number","num","4 Months RS",null],["RS_6M","number","num","6 Months RS",null],["MCAP_CR","number","num","Market Cap",10000000],["LIN_3M","number","num","3 Month Linearity >= 0.5",null],["LIN_1M","number","num","1 Month Linearity >= 0.5",null],["RVOL_AVG_3M","number","num","Rvol_Avg_3_Month",null],["PE","number","num","PE",null],["CLOSE","number","num","Close",null],["ROE","number","num","ROE",null],["DEBT","number","num","Debt",null],["CASHFLOW","number","num","Cash Flow",null],["BOOKVAL","number","num","Book Val",null],["TURNOVER_CR","number","num","Net Turnover",10000000],["PROM_HOLD","number","num","Prom Hold %",null],["NARROW_RANGE","number","num","Narrow Range",null],["RANGE_5D","number","num","5 Days Range%",null],["RANGE_10D","number","num","10 Days Range%",null],["RANGE_15D","number","num","15 Days Range%",null],["RANGE_21D","number","num","21 Days Range%",null],["AFH_0_5M","number","num","Away_From_High_0_5_Month",null],["AFH_1M","number","num","Away_From_High_1_Month",null],["AFH_2M","number","num","Away_From_High_2_Month",null],["AFH_3M","number","num","Away_From_High_3_Month",null],["AFH_4M","number","num","Away_From_High_4_Month",null],["AFH_5M","number","num","Away_From_High_5_Month",null],["AFH_6M","number","num","Away_From_High_6_Month",null],["AFH_9M","number","num","Away_From_High_9_Month",null],["CHG_1D","number","num","1 Day Chng%",null],["CHG_5D","number","num","5 Days Chng%",null],["CHG_1M","number","num","1 Month Chng%",null],["CHG_2M","number","num","2 Months Chng%",null],["CHG_3M","number","num","3 Months Chng%",null],["CHG_4M","number","num","4 Months Chng%",null],["CHG_6M","number","num","6 Months Chng%",null],["DCR_1","number","num","DCR_1",null],["DCR_5","number","num","DCR_5",null],["DCR_10","number","num","DCR_10",null],["DCR_15","number","num","DCR_15",null],["RMV_15","number","num","RMV_15",null],["RMV_21","number","num","RMV_21",null],["RMV_42","number","num","RMV_42",null],["EPS_Q1","number","num","EPS Latest Qtr %",null],["EPS_Q2","number","num","EPS Prev Qtr %",null],["SALES_Q1","number","num","Sales Latest Qtr %",null],["SALES_Q2","number","num","Sales Prev Qtr %",null],["EPS_QOQ1","number","num","EPS Latest Qtr QoQ %",null],["SALES_QOQ1","number","num","Sales Latest Qtr QoQ %",null],["EPS_QOQ2","number","num","EPS Prev Qtr QoQ %",null],["SALES_QOQ2","number","num","Sales Prev Qtr QoQ %",null],["BI_RANK_PCT","number","special",null,null],["IND_RANK_PCT","number","special",null,null],["BI5D_RANK_PCT","number","special",null,null],["IND5D_RANK_PCT","number","special",null,null],["BI1M_RANK_PCT","number","special",null,null],["IND1M_RANK_PCT","number","special",null,null],["VOL_ABOVE_AVG","bool","raw","Volume Above Avg",null],["TURNOVER_ABOVE_AVG","bool","raw","Turnover Above Avg",null],["DELIVERY_ABOVE_AVG","bool","raw","Delivery Above Avg",null],["TRADABLE","bool","raw","Is Tradable",null],["FNO","bool","raw","F&O",null],["RS_TREND_5","bool","raw","RS_Trend_5",null],["RS_TREND_10","bool","raw","RS_Trend_10",null],["AAI_1D","bool","raw","Above All Indices (1D)",null],["AAI_5D","bool","raw","Above All Indices (5D)",null],["AAI_1M","bool","raw","Above All Indices (1M)",null],["AAI_2M","bool","raw","Above All Indices (2M)",null],["AAI_3M","bool","raw","Above All Indices (3M)",null],["AAI_4M","bool","raw","Above All Indices (4M)",null],["AAI_6M","bool","raw","Above All Indices (6M)",null],["HL_STRUCTURE","bool","raw","Higher_Low_Structure",null],["HL_STRUCTURE_3M","bool","raw","Higher_Low_Structure_3M",null],["ADV_DECL","number","raw","Advancing_Neutral_Declining",null],["SECTOR","text","raw","Sector",null],["INDUSTRY","text","raw","Industry",null],["MACRO_SECTOR","text","raw","Macro Economic Sector",null],["BASIC_INDUSTRY","text","raw","Basic Industry",null],["PRICE_BAND","text","str","Price Band %",null],["ALL_INDEX","text","special",null,null],["CODE","text","raw","Code",null],["NAME","text","raw","Name",null],["AWAY_SMA10","number","num","Away_From_SMA10",null],["AWAY_SMA20","number","num","Away_From_SMA20",null],["AWAY_SMA50","number","num","Away_From_SMA50",null],["AWAY_SMA100","number","num","Away_From_SMA100",null],["AWAY_SMA150","number","num","Away_From_SMA150",null],["AWAY_SMA200","number","num","Away_From_SMA200",null]];
const ADV_OPS = ["=", "!=", "<>", ">", "<", ">=", "<="];
const ADV_BY_NAME = new Map(ADV_SPEC.map(([name, type, kind, key, scale]) => [name, { name, type, kind, key, scale }]));

function advValue(f, i) {
    switch (f.kind) {
        case "num":
            return f.scale ? col(f.key)[i] / f.scale : col(f.key)[i];
        case "raw":
            return rows[i][f.key];
        case "str":
            return String(rows[i][f.key]);
        default: {
            // special: rank percentiles + All Index
            const r = rows[i];
            switch (f.name) {
                case "BI_RANK_PCT": {
                    const p = peerRank.get(r.Code);
                    return p ? p.biPct : NaN;
                }
                case "IND_RANK_PCT": {
                    const p = peerRank.get(r.Code);
                    return p ? p.indPct : NaN;
                }
                case "BI5D_RANK_PCT": {
                    const g = groupRank.get(r["Basic Industry"]);
                    return g && g.bi5dPct !== undefined ? g.bi5dPct : NaN;
                }
                case "IND5D_RANK_PCT": {
                    const g = groupRank.get(r["Industry"]);
                    return g && g.ind5dPct !== undefined ? g.ind5dPct : NaN;
                }
                case "BI1M_RANK_PCT": {
                    const g = groupRank.get(r["Basic Industry"]);
                    return g && g.bi1mPct !== undefined ? g.bi1mPct : NaN;
                }
                case "IND1M_RANK_PCT": {
                    const g = groupRank.get(r["Industry"]);
                    return g && g.ind1mPct !== undefined ? g.ind1mPct : NaN;
                }
                case "ALL_INDEX":
                    return getAllIndexValues(r);
            }
            return undefined;
        }
    }
}

function advTokenize(str) {
    const tokens = [];
    const re = /\s*(<=|>=|!=|<>|=|<|>|\(|\)|"[^"]*"|'[^']*'|[A-Za-z_][A-Za-z0-9_]*|[-+]?\d+(?:\.\d+)?)\s*/y;
    let idx = 0;
    while (idx < str.length) {
        re.lastIndex = idx;
        const m = re.exec(str);
        if (!m) throw new Error(`Unexpected character near "${str.slice(idx, idx + 10)}"`);
        tokens.push(m[1]);
        idx = re.lastIndex;
    }
    return tokens;
}

function advCompareValues(rawVal, op, value, type) {
    const normOp = op === "<>" ? "!=" : op;
    if (type === "number") {
        const v = typeof rawVal === "number" ? rawVal : parseFloat(rawVal);
        const target = typeof value === "number" ? value : parseFloat(value);
        if (isNaN(v) || isNaN(target)) return false;
        switch (normOp) {
            case "=": return v === target;
            case "!=": return v !== target;
            case ">": return v > target;
            case "<": return v < target;
            case ">=": return v >= target;
            case "<=": return v <= target;
        }
        return false;
    } else if (type === "bool") {
        const boolVal = rawVal === "Yes" || rawVal === true || rawVal == 1;
        const targetStr = String(value).toLowerCase();
        const targetBool = ["yes", "true", "1"].includes(targetStr);
        if (normOp === "=") return boolVal === targetBool;
        if (normOp === "!=") return boolVal !== targetBool;
        return false;
    } else if (Array.isArray(rawVal)) {
        const targetStr = String(value).toLowerCase();
        const has = rawVal.some((v) => String(v).toLowerCase() === targetStr);
        if (normOp === "=") return has;
        if (normOp === "!=") return !has;
        return false;
    } else {
        const strVal = (rawVal ?? "").toString().toLowerCase();
        const targetStr = String(value).toLowerCase();
        if (normOp === "=") return strVal === targetStr;
        if (normOp === "!=") return strVal !== targetStr;
        return false;
    }
}

// Returns (rowIndex) => boolean
function advParse(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    function parseExpr() {
        let left = parseTerm();
        while (peek() && peek().toUpperCase() === "OR") {
            next();
            const l = left,
                r = parseTerm();
            left = (i) => l(i) || r(i);
        }
        return left;
    }
    function parseTerm() {
        let left = parseFactor();
        while (peek() && peek().toUpperCase() === "AND") {
            next();
            const l = left,
                r = parseFactor();
            left = (i) => l(i) && r(i);
        }
        return left;
    }
    function parseFactor() {
        if (peek() && peek().toUpperCase() === "NOT") {
            next();
            const f = parseFactor();
            return (i) => !f(i);
        }
        if (peek() === "(") {
            next();
            const e = parseExpr();
            if (peek() !== ")") throw new Error('Missing closing ")"');
            next();
            return e;
        }
        return parseCondition();
    }
    function parseCondition() {
        const fieldTok = next();
        if (fieldTok === undefined) throw new Error("Expected a field name");
        if (fieldTok === "(" || fieldTok === ")") throw new Error(`Unexpected "${fieldTok}"`);
        const field = ADV_BY_NAME.get(fieldTok.toUpperCase());
        if (!field) throw new Error(`Unknown field "${fieldTok}"`);
        const opTok = next();
        if (!opTok || !ADV_OPS.includes(opTok)) throw new Error(`Expected an operator (>=, <=, >, <, =, !=) after "${fieldTok}"`);
        const valTok = next();
        if (valTok === undefined) throw new Error(`Expected a value after "${fieldTok} ${opTok}"`);

        const isQuoted = /^["'].*["']$/.test(valTok);
        const isNumericTok = /^[-+]?\d+(?:\.\d+)?$/.test(valTok);
        if (!isQuoted && !isNumericTok) {
            const other = ADV_BY_NAME.get(valTok.toUpperCase());
            if (other) {
                const type = field.type === "number" && other.type === "number" ? "number" : field.type;
                return (i) => advCompareValues(advValue(field, i), opTok, advValue(other, i), type);
            }
        }
        let value;
        if (isQuoted) value = valTok.slice(1, -1);
        else if (isNumericTok) value = parseFloat(valTok);
        else value = valTok;
        return (i) => advCompareValues(advValue(field, i), opTok, value, field.type);
    }

    if (!tokens.length) throw new Error("Empty query");
    const expr = parseExpr();
    if (pos !== tokens.length) throw new Error(`Unexpected token "${tokens[pos]}"`);
    return expr;
}

/* ---- the filter itself (one implementation for applyFilters AND runFilterState) ---- */
// [stateIdPrefix, rowKey, divisor]  → reads state[prefix + "_min"] / "_max"
const RANGES = [
    ["f_rs", "RS TOTAL"], ["f_rs1m", "1 Month RS"], ["f_rs3m", "3 Months RS"], ["f_rs2m", "2 Months RS"],
    ["f_rs4m", "4 Months RS"], ["f_rs6m", "6 Months RS"], ["f_mcap", "Market Cap", 10000000],
    ["f_pe", "PE"], ["f_close", "Close"], ["f_roe", "ROE"], ["f_debt", "Debt"], ["f_cashflow", "Cash Flow"],
    ["f_bookval", "Book Val"], ["f_to", "Net Turnover", 10000000], ["f_prom", "Prom Hold %"],
    ["f_eps1", "EPS Latest Qtr %"], ["f_eps2", "EPS Prev Qtr %"], ["f_sal1", "Sales Latest Qtr %"],
    ["f_sal2", "Sales Prev Qtr %"], ["f_epsq1", "EPS Latest Qtr QoQ %"], ["f_salq1", "Sales Latest Qtr QoQ %"],
    ["f_epsq2", "EPS Prev Qtr QoQ %"], ["f_salq2", "Sales Prev Qtr QoQ %"],
    ["f_dcr1", "DCR_1"], ["f_dcr5", "DCR_5"], ["f_dcr10", "DCR_10"], ["f_dcr15", "DCR_15"],
    ["f_rmv15", "RMV_15"], ["f_rmv21", "RMV_21"], ["f_rmv42", "RMV_42"],
    ["f_5dr", "5 Days Range%"], ["f_10dr", "10 Days Range%"], ["f_15dr", "15 Days Range%"], ["f_21dr", "21 Days Range%"],
    ["f_afh_0_5m", "Away_From_High_0_5_Month"], ["f_afh1m", "Away_From_High_1_Month"], ["f_afh2m", "Away_From_High_2_Month"],
    ["f_afh3m", "Away_From_High_3_Month"], ["f_afh4m", "Away_From_High_4_Month"], ["f_afh5m", "Away_From_High_5_Month"],
    ["f_afh6m", "Away_From_High_6_Month"], ["f_afh9m", "Away_From_High_9_Month"],
    ["f_sma10", "Away_From_SMA10"], ["f_sma20", "Away_From_SMA20"], ["f_sma50", "Away_From_SMA50"],
    ["f_sma100", "Away_From_SMA100"], ["f_sma150", "Away_From_SMA150"], ["f_sma200", "Away_From_SMA200"],
    ["f_chg1d", "1 Day Chng%"], ["f_chg5d", "5 Days Chng%"], ["f_chg1m", "1 Month Chng%"], ["f_chg3m", "3 Months Chng%"],
    ["f_chg2m", "2 Months Chng%"], ["f_chg4m", "4 Months Chng%"], ["f_chg6m", "6 Months Chng%"],
];
// [stateId, rowKey]  → single lower bound
const MIN_ONLY = [
    ["f_lin3m_min", "3 Month Linearity >= 0.5"], ["f_lin1m_min", "1 Month Linearity >= 0.5"],
    ["f_rvol_avg_3m_min", "Rvol_Avg_3_Month"], ["f_nr_min", "Narrow Range"],
];
// checkbox → row[key] must equal "Yes"
const YES_FLAGS = [["f_vol_abv", "Volume Above Avg"], ["f_to_abv", "Turnover Above Avg"], ["f_del_abv", "Delivery Above Avg"]];
// checkbox → row[key] must be == 1
const ONE_FLAGS = [
    ["f_tradable", "Is Tradable"], ["f_fno", "F&O"], ["f_rs_trend_5", "RS_Trend_5"], ["f_rs_trend_10", "RS_Trend_10"],
    ["f_aai_1d", "Above All Indices (1D)"], ["f_aai_5d", "Above All Indices (5D)"], ["f_aai_1m", "Above All Indices (1M)"],
    ["f_aai_2m", "Above All Indices (2M)"], ["f_aai_3m", "Above All Indices (3M)"], ["f_aai_4m", "Above All Indices (4M)"],
    ["f_aai_6m", "Above All Indices (6M)"], ["f_hl_structure", "Higher_Low_Structure"], ["f_hl_structure_3m", "Higher_Low_Structure_3M"],
];

const numOrNull = (v) => {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
};

// returns { idx: Int32Array (ascending row order), adv: null | {ok, message?} }
function runFilter(state, wlCodes) {
    const arr = (id) => state[id] || [];
    const macros = arr("f_macro"), sectors = arr("f_sector"), industries = arr("f_industry"), basics = arr("f_basic");
    const bands = arr("f_priceband"), advDecl = arr("f_adv_decl"), allIndexSel = arr("f_allindex");
    const search = String(state.f_search || "").toLowerCase();
    const wlSet = wlCodes ? new Set(wlCodes) : null;

    const ranges = [];
    for (const [id, key, scale] of RANGES) {
        const mn = numOrNull(state[id + "_min"]),
            mx = numOrNull(state[id + "_max"]);
        if (mn !== null || mx !== null) ranges.push({ c: col(key), mn, mx, sc: scale || 0 });
    }
    for (const [id, key] of MIN_ONLY) {
        const mn = numOrNull(state[id]);
        if (mn !== null) ranges.push({ c: col(key), mn, mx: null, sc: 0 });
    }
    const yes = YES_FLAGS.filter(([id]) => !!state[id]).map(([, k]) => k);
    const one = ONE_FLAGS.filter(([id]) => !!state[id]).map(([, k]) => k);

    const rankIds = ["f_bi_rank_pct", "f_ind_rank_pct", "f_bi5d_rank_pct", "f_ind5d_rank_pct", "f_bi1m_rank_pct", "f_ind1m_rank_pct"];
    const [biP, indP, bi5P, ind5P, bi1P, ind1P] = rankIds.map((id) => numOrNull(state[id]));
    const anyRank = rankIds.some((id) => numOrNull(state[id]) !== null);

    const out = [];
    for (let i = 0; i < N; i++) {
        const r = rows[i];
        if (search) {
            const code = (r.Code || "").toLowerCase(),
                name = (r.Name || "").toLowerCase();
            if (!code.includes(search) && !name.includes(search)) continue;
        }
        if (macros.length && !macros.includes(r["Macro Economic Sector"])) continue;
        if (sectors.length && !sectors.includes(r["Sector"])) continue;
        if (industries.length && !industries.includes(r["Industry"])) continue;
        if (basics.length && !basics.includes(r["Basic Industry"])) continue;
        if (bands.length && !bands.includes(String(r["Price Band %"]))) continue;
        if (advDecl.length && !advDecl.includes(String(r["Advancing_Neutral_Declining"]))) continue;
        if (allIndexSel.length && !getAllIndexValues(r).some((v) => allIndexSel.includes(v))) continue;
        if (wlSet && !wlSet.has(r.Code)) continue;

        let ok = true;
        for (let k = 0; k < ranges.length; k++) {
            const q = ranges[k];
            const v = q.sc ? q.c[i] / q.sc : q.c[i];
            if (q.mn !== null && (isNaN(v) || v < q.mn)) { ok = false; break; }
            if (q.mx !== null && (isNaN(v) || v > q.mx)) { ok = false; break; }
        }
        if (!ok) continue;

        if (anyRank) {
            const pr = peerRank.get(r.Code);
            if (biP !== null && (!pr || pr.biPct > biP)) continue;
            if (indP !== null && (!pr || pr.indPct > indP)) continue;
            if (bi5P !== null) { const g = groupRank.get(r["Basic Industry"]); if (!g || g.bi5dPct === undefined || g.bi5dPct > bi5P) continue; }
            if (ind5P !== null) { const g = groupRank.get(r["Industry"]); if (!g || g.ind5dPct === undefined || g.ind5dPct > ind5P) continue; }
            if (bi1P !== null) { const g = groupRank.get(r["Basic Industry"]); if (!g || g.bi1mPct === undefined || g.bi1mPct > bi1P) continue; }
            if (ind1P !== null) { const g = groupRank.get(r["Industry"]); if (!g || g.ind1mPct === undefined || g.ind1mPct > ind1P) continue; }
        }

        for (let k = 0; k < yes.length; k++) if (r[yes[k]] !== "Yes") { ok = false; break; }
        if (!ok) continue;
        for (let k = 0; k < one.length; k++) if (r[one[k]] != 1) { ok = false; break; }
        if (!ok) continue;

        out.push(i);
    }

    let idx = Int32Array.from(out);
    let adv = null;
    const advText = String(state.f_adv_query || "").trim();
    if (state.f_adv_enabled && advText) {
        try {
            const tokens = advTokenize(advText);
            const pred = tokens.length ? advParse(tokens) : null;
            if (pred) idx = idx.filter((i) => pred(i));
            adv = { ok: true };
        } catch (e) {
            adv = { ok: false, message: e.message };
        }
    }
    return { idx, adv };
}

/* ---- grouping ---- */
const IND_CHNG_KEYS = ["1 Day Chng%", "5 Days Chng%", "1 Month Chng%", "2 Months Chng%", "3 Months Chng%", "4 Months Chng%", "6 Months Chng%"];

function groupStats(groupField, industryName) {
    const map = {};
    for (let i = 0; i < N; i++) {
        const r = rows[i];
        if (industryName && r["Industry"] !== industryName) continue;
        const grp = r[groupField] || "—";
        let g = map[grp];
        if (!g) {
            g = map[grp] = {
                name: grp,
                macro: r["Macro Economic Sector"] || "",
                sector: r["Sector"] || "",
                industry: r["Industry"] || "",
                basicIndustry: r["Basic Industry"] || "",
                stockCount: 0,
                sums: {},
                counts: {},
            };
            IND_CHNG_KEYS.forEach((k) => { g.sums[k] = 0; g.counts[k] = 0; });
        }
        g.stockCount++;
        IND_CHNG_KEYS.forEach((k) => {
            const v = parseFloat(r[k]);
            if (!isNaN(v)) { g.sums[k] += v; g.counts[k]++; }
        });
    }
    return Object.values(map).map((g) => {
        const avgs = {};
        IND_CHNG_KEYS.forEach((k) => { avgs[k] = g.counts[k] > 0 ? g.sums[k] / g.counts[k] : null; });
        return { name: g.name, macro: g.macro, sector: g.sector, industry: g.industry, basicIndustry: g.basicIndustry, stockCount: g.stockCount, avgs };
    });
}

function chainCounts(field, idx) {
    const counts = new Map();
    for (const i of idx) {
        const r = rows[i];
        const key = (r[field] || "").toString().trim();
        if (!key) continue;
        const macro = (r["Macro Economic Sector"] || "").toString().trim();
        const sector = (r["Sector"] || "").toString().trim();
        const industry = (r["Industry"] || "").toString().trim();
        const parts = field === "Basic Industry" ? [macro, sector, industry] : [macro, sector];
        const existing = counts.get(key);
        if (existing) existing.count += 1;
        else counts.set(key, { name: key, breadcrumb: parts.filter(Boolean).join(" › "), count: 1 });
    }
    return Array.from(counts.values()).sort((a, b) => b.count - a.count);
}

/* ───────────────────────────── CHART ROLE ───────────────────────────── */
let chartGen = 0; // newest thumbnail generation announced by the page

/* ---- indicator maths: provided by indicator-calculators.js (importScripts at top) ---- */


/* ---- IndicatorCacheDB wrappers (same keys / payloads the page always used) ---- */
const cacheOK = () => IDB_OK && typeof IndicatorCacheDB !== "undefined";
async function cacheGet(isin, key, date) {
    if (!cacheOK()) return null;
    try { return await IndicatorCacheDB.get(isin, key, date); } catch (e) { return null; }
}
async function cacheSet(isin, key, date, val) {
    if (!cacheOK()) return;
    try { IndicatorCacheDB.writeBehind(date, [{ isin, key, payload: val }]); } catch (e) { /* cache is best-effort; write is queued, not awaited */ }
}

async function handleChart(m) {
    if (!CALC_OK || typeof calculateSMA !== "function") {
        throw new Error("helper/indicator-calculators.js failed to load in data-worker.js");
    }
    const { isin, mode, settings: S, sliceLen, gen, dataDate, baseUrl } = m;
    const res = await fetch(baseUrl + isin + ".json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    // A newer thumbnail pass started while we were downloading — skip the maths.
    if (mode === "thumb" && gen < chartGen) return { cancelled: true };

    const ind = {};
    const errors = [];
    const full = mode === "full";

    // Every task mirrors one IndicatorCacheDB key the page used to compute itself.
    const tasks = [];
    const add = (key, fn) => tasks.push({ key, fn });

    if (S.volume && S.volume.enabled && S.volume.maLength > 0) {
        add("volume_sma_" + S.volume.maLength, () => calculateSMA(data, S.volume.maLength, "volume"));
    }
    (S.avwap || []).forEach((avwap) => {
        if (!avwap.enabled || avwap.date == "") return;
        avwap.multipliers = [avwap.multiplier0,avwap.multiplier1, avwap.multiplier2];
        add("avwap_"+avwap.date + "_" + avwap.source + "_" + avwap.multiplier0 + "_" + avwap.multiplier1 + "_" + avwap.multiplier2, () => calculateAnchoredVWAP(data, avwap));
    });
    (S.afh_avwap || []).forEach((avwap) => {
        if (!avwap.enabled || avwap.length < 15) return;
        add("afh_avwap_" + avwap.length + "_" + avwap.source + "_" + avwap.multiplier0 + "_" + avwap.multiplier1 + "_" + avwap.multiplier2,
            () => calculateAfhAnchoredVWAP(data, avwap));
    });
    (S.ma || []).forEach((ma) => {
        if (!ma.enabled) return;
        add(ma.type + "_" + ma.length + "_" + ma.source, () => (ma.type === "ema" ? calculateEMA(data, ma.length, ma.source) : calculateSMA(data, ma.length, ma.source)));
    });
    (S.supertrend || []).forEach((st) => {
        if (!st.enabled) return;
        add("supertrend_" + st.atrLength + "_" + st.factor, () => calculateSupertrend(data, st));
    });
    (S.pivottrendline || []).forEach((p) => {
        if (!p.enabled || (full && !(p.length > 1))) return;
        add("pivottrendline_" + p.length + "_high", () => calculateTrendlinePoints(data, p.length, "high"));
        add("pivottrendline_" + p.length + "_low", () => calculateTrendlinePoints(data, p.length, "low"));
    });
    (S.afh || []).forEach((a) => {
        if (!a.enabled || !(a.length >= 15)) return;
        add("afh_" + a.length, () => calculateHighestHighResistance(data, { length: a.length }));
    });
    if (full && S.rsi && S.rsi.enabled) {
        const r = S.rsi;
        const rsiKey = "rsi_" + r.length + "_" + r.source + "_" + r.smoothingType + "_" + r.smoothingLength;
        add(rsiKey, () => calculateRSI(data, r));
        if (r.smoothingLength > 0 && r.smoothingType !== "none") {
            // depends on the RSI series; resolved after the first pass below
        }
    }
    if (full && S.macd && S.macd.enabled) {
        const c = S.macd;
        add("macd_" + c.source + "_" + c.fastLength + "_" + c.slowLength + "_" + c.signalLength + "_" + c.oscMaType + "_" + c.signalMaType, () => calculateMACD(data, c));
    }

    const runTask = async ({ key, fn }) => {
        try {
            let v = await cacheGet(isin, key, dataDate);
            if (!v) {
                v = fn();
                await cacheSet(isin, key, dataDate, v);
            }
            ind[key] = v;
        } catch (e) {
            errors.push(key + ": " + ((e && e.message) || e));
        }
    };
    await Promise.all(tasks.map(runTask));

    // RSI smoothing runs on the RSI output, so it goes second.
    if (full && S.rsi && S.rsi.enabled && S.rsi.smoothingLength > 0 && S.rsi.smoothingType !== "none") {
        const r = S.rsi;
        const rsiKey = "rsi_" + r.length + "_" + r.source + "_" + r.smoothingType + "_" + r.smoothingLength;
        const smaKey = "rsi_sma_" + r.length + "_" + r.source + "_" + r.smoothingType + "_" + r.smoothingLength;
        if (ind[rsiKey]) {
            await runTask({
                key: smaKey,
                fn: () => (r.smoothingType === "ema" ? calculateEMA(ind[rsiKey], r.smoothingLength, "value") : calculateSMA(ind[rsiKey], r.smoothingLength, "value")),
            });
        }
    }

    if (mode === "thumb" && sliceLen) {
        for (const k of Object.keys(ind)) if (Array.isArray(ind[k])) ind[k] = ind[k].slice(sliceLen);
        return { data: data.slice(sliceLen), ind, errors };
    }
    return { data, ind, errors };
}

/* ───────────────────────────── MESSAGE ROUTER ───────────────────────────── */
self.onmessage = async function (e) {
    const m = e.data || {};
    const reply = (payload, transfer) => self.postMessage({ id: m.id, ...payload }, transfer || []);
    try {
        switch (m.type) {
            case "INIT": {
                rows = m.rows || [];
                N = rows.length;
                colCache.clear();
                computeRanks();
                let advMismatch = null;
                if (Array.isArray(m.advNames)) {
                    const mine = new Set(ADV_SPEC.map((s) => s[0]));
                    const theirs = new Set(m.advNames);
                    const missing = m.advNames.filter((n) => !mine.has(n));
                    const extra = ADV_SPEC.map((s) => s[0]).filter((n) => !theirs.has(n));
                    if (missing.length || extra.length) advMismatch = { missing, extra };
                }
                reply({ ok: true, peerRank, groupRank, advMismatch });
                break;
            }
            case "FILTER": {
                const t0 = performance.now();
                const { idx, adv } = runFilter(m.state || {}, m.wlCodes);
                const out = m.doSort ? sortIndices(idx, m.sortCol, m.sortDir) : idx;
                reply({ idx: out, adv, ms: performance.now() - t0 }, [out.buffer]);
                break;
            }
            case "SORT": {
                const out = sortIndices(m.idx, m.sortCol, m.sortDir);
                reply({ idx: out }, [out.buffer]);
                break;
            }
            case "GROUP_STATS":
                reply({ groups: groupStats(m.field, m.industry || null) });
                break;
            case "CHAIN_COUNTS":
                reply({ groups: chainCounts(m.field, m.idx) });
                break;
            case "RUN_STATES": {
                const results = (m.jobs || []).map((job) => {
                    try {
                        const { idx, adv } = runFilter(job.state || {}, job.wlCodes);
                        if (adv && !adv.ok) console.warn("Advanced query in saved search failed to parse:", job.state && job.state.f_adv_query, adv.message);
                        return Array.from(idx, (i) => rows[i].Code);
                    } catch (err) {
                        console.warn("[data-worker] state run failed:", err);
                        return null;
                    }
                });
                reply({ results });
                break;
            }
            case "SET_GEN":
                chartGen = Math.max(chartGen, m.gen | 0);
                break; // fire-and-forget, no reply
            case "CHART": {
                const r = await handleChart(m);
                reply(r);
                break;
            }
            default:
                reply({ error: "unknown message type: " + m.type });
        }
    } catch (err) {
        reply({ error: (err && err.message) || String(err) });
    }
};
