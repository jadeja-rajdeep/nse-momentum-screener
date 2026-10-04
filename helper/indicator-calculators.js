/* ============================================================================
   indicator-calculators.js — the ACTUAL indicator math, extracted verbatim
   from index.html so the chart overlays and indicator-worker.js compute
   IDENTICAL numbers and share IDENTICAL IndicatorCacheDB cache entries.

   index.html should include this file with
     <script src="./helper/indicator-calculators.js"></script>
   BEFORE the inline <script> block, then DELETE the duplicate definitions
   of getSourceValue / calculateSMA / calculateEMA / calculateMACD /
   calculateRSI / calculateSupertrend / calculateHighestHighResistance /
   calculateTrendlinePoints from the inline block — one copy of this math
   anywhere, used by chart rendering, the indicator worker, AND the query
   engine.

   Canonical indicator cache keys (MUST exactly match what the existing
   chart-rendering code already builds and reads/writes via
   IndicatorCacheDB, so a key precomputed by the worker is reused instantly
   when a chart is later opened, and vice versa — same cache, same keys,
   computed once):

     ema_<length>_<source>              -> array of {time,value}
     sma_<length>_<source>              -> array of {time,value}
     supertrend_<atrLength>_<factor>    -> array of {time,value,color}
     rsi_<length>_<source>_<smoothingType>_<smoothingLength>
                                         -> array of {time,value}
     rsi_sma_<length>_<source>_<smoothingType>_<smoothingLength>
                                         -> array of {time,value} (the RSI's
                                            own smoothing line — name has
                                            "sma" literally even when
                                            smoothingType is "ema", because
                                            that's the exact key string
                                            already used in production)
     macd_<source>_<fastLength>_<slowLength>_<signalLength>_<oscMaType>_<signalMaType>
                                         -> { macdLine, signalLine, histogram }
                                            (three arrays of {time,value})
     afh_<length>                       -> { price, index, dataPoint }
     pivottrendline_<length>_high       -> { lineA, lineB, pivots }
     pivottrendline_<length>_low        -> { lineA, lineB, pivots }

   Query-time field syntax (what the person types in the Advance Indicator
   Query box) reuses these EXACT canonical keys for the array-shaped ones
   (ema_50_close[0]), and adds a ".subfield" for the object-shaped ones,
   since "give me the whole object" isn't a number:

     macd_close_12_26_9_ema_ema.line[0]      (or .signal / .hist)
     afh_60[0]                                (no subfield — it's one scalar)
     pivottrendline_20_high.a[0]              (or .b)
     pivottrendline_20_low.a[0]               (or .b)

   See extractQuerySeries() / deriveQueryFieldsFromCanonicalKeys() at the
   bottom — that's the ONLY place that knows about the ".subfield" mapping;
   everything upstream (worker, cache) only ever deals in canonical keys.
   ========================================================================= */


   function getSourceValue(candle, source = "close") {
       if (!candle) {
           return undefined;
       }

       switch (source) {
           case "open":
               return candle.open;

           case "high":
               return candle.high;

           case "low":
               return candle.low;

           case "close":
               return candle.close;

           case "hl2":
               return (candle.high + candle.low) / 2;

           case "hlc3":
               return (candle.high + candle.low + candle.close) / 3;

           case "ohlc4":
               return (candle.open + candle.high + candle.low + candle.close) / 4;

           case "volume":
               return candle.v;

           case "value":
               return candle.value;

           default:
               return candle.close;
       }
   }

   function calculateSMA(data, period, source = "close") {
       if (!Array.isArray(data) || data.length === 0 || period <= 0) {
           return [];
       }

       const result = [];

       // Keep track of valid values only.
       const validData = [];

       for (const item of data) {
           const value = Number(getSourceValue(item, source));

           if (Number.isFinite(value)) {
               validData.push({
                   time: item.time,
                   value,
               });
           }
       }

       // Not enough valid values to calculate SMA.
       if (validData.length < period) {
           return data.map((item) => ({
               time: item.time,
           }));
       }

       // Map calculated values by time.
       const smaMap = new Map();

       let sum = 0;

       for (let i = 0; i < validData.length; i++) {
           sum += validData[i].value;

           if (i >= period) {
               sum -= validData[i - period].value;
           }

           if (i >= period - 1) {
               smaMap.set(validData[i].time, sum / period);
           }
       }

       // Restore the complete original timeline.
       for (const item of data) {
           const value = smaMap.get(item.time);

           if (value !== undefined) {
               result.push({
                   time: item.time,
                   value,
               });
           } else {
               // Lightweight Charts whitespace
               result.push({
                   time: item.time,
               });
           }
       }

       return result;
   }

   function calculateEMA(data, period, source = "close") {
       if (!Array.isArray(data) || data.length === 0 || period <= 0) {
           return [];
       }

       // Extract only valid numeric values.
       const validData = [];

       for (const item of data) {
           const value = Number(getSourceValue(item, source));

           if (Number.isFinite(value)) {
               validData.push({
                   time: item.time,
                   value,
               });
           }
       }

       // Not enough valid values.
       if (validData.length < period) {
           return data.map((item) => ({
               time: item.time,
           }));
       }

       const emaMap = new Map();

       // Initial SMA.
       let sum = 0;

       for (let i = 0; i < period; i++) {
           sum += validData[i].value;
       }

       let ema = sum / period;

       emaMap.set(validData[period - 1].time, ema);

       const multiplier = 2 / (period + 1);

       // Remaining EMA values.
       for (let i = period; i < validData.length; i++) {
           ema = (validData[i].value - ema) * multiplier + ema;

           emaMap.set(validData[i].time, ema);
       }

       // Restore complete original timeline.
       const result = data.map((item) => {
           const value = emaMap.get(item.time);

           if (value !== undefined) {
               return {
                   time: item.time,
                   value,
               };
           }

           // Lightweight Charts whitespace.
           return {
               time: item.time,
           };
       });

       return result;
   }

   function calculateMACD(data, options = {}) {
       const { fastLength = 12, histNegativeColor = "#ef4444", histPositiveColor = "#22c55e", macdLineColor = "#3b82f6", oscMaType = "ema", signalLength = 9, signalLineColor = "#f59e0b", signalMaType = "ema", slowLength = 26, source = "close" } = options;

       if (!data || data.length === 0) {
           return { macdLine: [], signalLine: [], histogram: [] };
       }

       // 1. Extract the selected source series into [{ time, value }]
       const sourceSeries = data.map((item) => ({
           time: item.time,
           value: Number(getSourceValue(item, source)),
       }));

       // 2. Calculate Fast and Slow MAs
       const fastMA = oscMaType === "ema" ? calculateEMA(sourceSeries, fastLength, "value") : calculateSMA(sourceSeries, fastLength, "value");
       const slowMA = oscMaType === "ema" ? calculateEMA(sourceSeries, slowLength, "value") : calculateSMA(sourceSeries, slowLength, "value");

       const fastMap = new Map(fastMA.map((item) => [item.time, item.value]));
       const slowMap = new Map(slowMA.map((item) => [item.time, item.value]));

       // 3. Compute MACD Line (Fast MA - Slow MA) over the FULL date range,
       //    inserting whitespace points where either MA isn't ready yet
       const macdLine = [];
       const macdValueMap = new Map(); // only real values, for signal calc

       for (const item of data) {
           const fastVal = fastMap.get(item.time);
           const slowVal = slowMap.get(item.time);

           if (fastVal !== undefined && slowVal !== undefined) {
               const value = fastVal - slowVal;
               macdLine.push({ time: item.time, value });
               macdValueMap.set(item.time, value);
           } else {
               // whitespace point: keeps the time axis aligned, plots nothing
               macdLine.push({ time: item.time });
           }
       }

       // 4. Compute Signal Line from the MACD line's real values only
       const macdRealSeries = macdLine.filter((d) => d.value !== undefined).map((d) => ({ time: d.time, value: d.value }));

       const signalReal = signalMaType === "ema" ? calculateEMA(macdRealSeries, signalLength, "value") : calculateSMA(macdRealSeries, signalLength, "value");

       const signalMap = new Map(signalReal.map((item) => [item.time, item.value]));

       // Build signalLine over the FULL date range too
       const signalLine = data.map((item) => {
           const val = signalMap.get(item.time);
           return val !== undefined ? { time: item.time, value: val } : { time: item.time };
       });

       // 5. Compute Histogram over the FULL date range
       const histogram = data.map((item) => {
           const macdVal = macdValueMap.get(item.time);
           const sigVal = signalMap.get(item.time);

           if (macdVal !== undefined && sigVal !== undefined) {
               const diff = macdVal - sigVal;
               return {
                   time: item.time,
                   value: diff,
                   color: diff >= 0 ? histPositiveColor : histNegativeColor,
               };
           }
           return { time: item.time }; // whitespace
       });

       return { macdLine, signalLine, histogram };
   }

   function calculateRSI(data, settings) {
       const { length = 14, source = "close", smoothingType = "none", smoothingLength = 14 } = settings || {};

       if (!Array.isArray(data) || data.length === 0) {
           return [];
       }

       const prices = data.map((d) => getSourceValue(d, source));
       const totalBars = data.length;
       const rsiSeries = [];

       // 2. Pad initial bars with null values if dataset is shorter than required length
       if (totalBars <= length) {
           const nullPadded = data.map((bar) => ({
               time: bar.time,
           }));
           return nullPadded;
       }

       // 3. Compute price gains and losses
       const gains = [];
       const losses = [];
       for (let i = 1; i < totalBars; i++) {
           const change = prices[i] - prices[i - 1];
           gains.push(change > 0 ? change : 0);
           losses.push(change < 0 ? -change : 0);
       }

       // First `length` bars (index 0 to length - 1) have no RSI value
       for (let i = 0; i < length; i++) {
           rsiSeries.push({ time: data[i].time });
       }

       // 4. Initial SMA for Gains and Losses over first `length` changes
       let avgGain = 0;
       let avgLoss = 0;
       for (let i = 0; i < length; i++) {
           avgGain += gains[i];
           avgLoss += losses[i];
       }
       avgGain /= length;
       avgLoss /= length;

       const computeRSI = (g, l) => {
           if (l === 0) return g === 0 ? 50 : 100;
           const rs = g / l;
           return Number((100 - 100 / (1 + rs)).toFixed(4));
       };

       // First valid RSI bar at index `length`
       rsiSeries.push({
           time: data[length].time,
           value: computeRSI(avgGain, avgLoss),
       });

       // 5. Subsequent RSI values using Wilder's Exponential Smoothing (RMA)
       for (let i = length; i < gains.length; i++) {
           avgGain = (avgGain * (length - 1) + gains[i]) / length;
           avgLoss = (avgLoss * (length - 1) + losses[i]) / length;

           rsiSeries.push({
               time: data[i + 1].time,
               value: computeRSI(avgGain, avgLoss),
           });
       }

       return rsiSeries;
   }

   function calculateHighestHighResistance(data, options) {
       const { length } = options;

       if (!Array.isArray(data) || data.length === 0 || !length || length <= 0) {
           return null;
       }

       // offsetDays = (length / 9) * 3, rounded to nearest integer day
       const offsetDays = Math.round((length / 9) * 3);

       const n = data.length;

       const startIndex = n - offsetDays - 1;

       if (startIndex < 1) {
           // Not enough data even after offset
           return null;
       }

       const from = startIndex;
       const to = Math.max(0, from - length);

       let highestHigh = -Infinity;
       let highestIndex = -1;

       // Single pass, O(n) — high performance, no allocations, no sorting
       for (let i = from; i >= to; i--) {
           const h = data[i].high;
           if (h > highestHigh) {
               highestHigh = h;
               highestIndex = i;
           }
       }

       if (highestIndex === -1) return null;

       return {
           price: highestHigh,
           index: highestIndex,
           dataPoint: data[highestIndex],
       };
   }

   function calculateSupertrend(data, options) {
       const { enabled = true, atrLength = 21, factor = 9, upColor = "#22c55e", downColor = "#ef4444" } = options || {};

       const n = data.length;
       const result = new Array(n);

       if (!enabled || n === 0) {
           for (let i = 0; i < n; i++) result[i] = { time: data[i].time };
           return result;
       }

       // ---- True Range ----
       const tr = new Array(n).fill(0);
       for (let i = 0; i < n; i++) {
           const { high, low, close } = data[i];
           if (i === 0) {
               tr[i] = high - low;
           } else {
               const prevClose = data[i - 1].close;
               tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
           }
       }

       // ---- ATR (Wilder's smoothing / RMA) ----
       const atr = new Array(n).fill(undefined);
       let sumTR = 0;
       for (let i = 0; i < n; i++) {
           if (i < atrLength) {
               sumTR += tr[i];
               if (i === atrLength - 1) atr[i] = sumTR / atrLength;
           } else {
               atr[i] = (atr[i - 1] * (atrLength - 1) + tr[i]) / atrLength;
           }
       }

       const firstValidIdx = atrLength - 1;

       let prevFinalUpper,
           prevFinalLower,
           prevClose,
           prevDirection = 1;

       for (let i = 0; i < n; i++) {
           const point = data[i];

           if (i < firstValidIdx || atr[i] === undefined) {
               result[i] = { time: point.time }; // whitespace: keeps timescale aligned
               continue;
           }

           const hl2 = (point.high + point.low) / 2;
           const basicUpper = hl2 + factor * atr[i];
           const basicLower = hl2 - factor * atr[i];

           let finalUpper, finalLower;

           if (i === firstValidIdx) {
               finalUpper = basicUpper;
               finalLower = basicLower;
           } else {
               finalUpper = basicUpper < prevFinalUpper || prevClose > prevFinalUpper ? basicUpper : prevFinalUpper;
               finalLower = basicLower > prevFinalLower || prevClose < prevFinalLower ? basicLower : prevFinalLower;
           }

           let direction;
           if (i === firstValidIdx) {
               direction = point.close <= finalUpper ? -1 : 1;
           } else if (prevDirection === 1) {
               direction = point.close < finalLower ? -1 : 1;
           } else {
               direction = point.close > finalUpper ? 1 : -1;
           }

           const value = direction === 1 ? finalLower : finalUpper;
           const color = direction === 1 ? upColor : downColor;

           result[i] = { time: point.time, value, color };

           prevFinalUpper = finalUpper;
           prevFinalLower = finalLower;
           prevClose = point.close;
           prevDirection = direction;
       }

       return result;
   }

   function calculateTrendlinePoints(data, length, mode = "high", skipWindows = 1) {
       if (!Array.isArray(data) || data.length === 0) {
           throw new Error("data must be a non-empty array");
       }
       if (!Number.isInteger(length) || length <= 0) {
           throw new Error("length must be a positive integer");
       }
       if (mode !== "high" && mode !== "low") {
           throw new Error("mode must be 'high' or 'low'");
       }
       if (!Number.isInteger(skipWindows) || skipWindows < 0) {
           throw new Error("skipWindows must be a non-negative integer");
       }

       function findExtreme(start, end) {
           let best = null;
           for (let i = start; i < end; i++) {
               const candle = data[i];
               const price = mode === "high" ? candle.high : candle.low;
               if (best === null || (mode === "high" ? price > best.price : price < best.price)) {
                   best = { index: i, time: candle.time, price };
               }
           }
           return best;
       }

       const n = data.length;

       // The most recent `skipWindows` blocks are ignored for pivot detection.
       const w1End = n - length * skipWindows;
       if (w1End <= 0) {
           throw new Error("Not enough data after skipping recent window(s)");
       }
       const w1Start = Math.max(0, w1End - length);

       const w2End = w1Start;
       const w2Start = Math.max(0, w2End - length);

       const w3End = w2Start;
       const w3Start = Math.max(0, w3End - length);

       const P1 = findExtreme(w1Start, w1End);
       const P2 = w2End - w2Start > 0 ? findExtreme(w2Start, w2End) : null;
       const P3 = w3End - w3Start > 0 ? findExtreme(w3Start, w3End) : null;

       // Lines still extend to the very latest bar (covers the skipped window).
       const latestIndex = n - 1;
       const latestTime = data[latestIndex].time;

       function extrapolate(pA, pB, targetIndex, targetTime) {
           const barsAB = pB.index - pA.index;
           if (barsAB === 0) {
               return { time: targetTime, value: pB.price };
           }
           const slopePerBar = (pB.price - pA.price) / barsAB;
           const barsToTarget = targetIndex - pB.index;
           return { time: targetTime, value: pB.price + slopePerBar * barsToTarget };
       }

       function dedupeByTime(points) {
           const seen = new Set();
           return points.filter((p) => {
               if (seen.has(p.time)) return false;
               seen.add(p.time);
               return true;
           });
       }

       const lineA = P3 && P2 ? dedupeByTime([{ time: P3.time, value: P3.price }, { time: P2.time, value: P2.price }, extrapolate(P3, P2, latestIndex, latestTime)]) : null;

       const lineB = P2 && P1 ? dedupeByTime([{ time: P2.time, value: P2.price }, { time: P1.time, value: P1.price }, extrapolate(P2, P1, latestIndex, latestTime)]) : null;

       return { lineA, lineB, pivots: { P1, P2, P3 } };
   }

   function calculateAnchoredVWAP(candles, settings = {}) {
       const {
           date,
           source = "hlc3",
           multipliers = [0.6, 0.9, 1.2],
       } = settings;

       // Active bands only: multiplier must be a number > 0
       const activeBands = [];
       multipliers.forEach((m, i) => {
           const mult = Number(m);
           if (Number.isFinite(mult) && mult > 0) {
               activeBands.push({ key: i + 1, mult });
           }
       });

       const result = { vwap: [] };
       activeBands.forEach(({ key }) => {
           result[`upper${key}`] = [];
           result[`lower${key}`] = [];
       });

       if (!Array.isArray(candles) || candles.length === 0 || date == null) {
           return result;
       }

       const toMs = (t) => {
           if (typeof t === "number") return t * 1000;
           if (typeof t === "string") return Date.parse(t);
           if (t && typeof t === "object") return Date.UTC(t.year, t.month - 1, t.day);
           return NaN;
       };

       const anchorMs = toMs(date);
       if (Number.isNaN(anchorMs)) return result;

       const hasBands = activeBands.length > 0;

       let cumVol = 0;
       let cumPV = 0;
       let cumPV2 = 0;

       for (const candle of candles) {
           if (toMs(candle.time) < anchorMs) continue;

           const price = getSourceValue(candle, source);
           const vol = candle.v;

           if (price === undefined || price === null || Number.isNaN(price)) continue;
           if (vol === undefined || vol === null || Number.isNaN(vol)) continue;

           cumVol += vol;
           cumPV += price * vol;
           if (hasBands) cumPV2 += price * price * vol;

           if (cumVol <= 0) continue;

           const vwap = cumPV / cumVol;
           result.vwap.push({ time: candle.time, value: vwap });

           if (hasBands) {
               const variance = Math.max(cumPV2 / cumVol - vwap * vwap, 0);
               const stdev = Math.sqrt(variance);

               for (const { key, mult } of activeBands) {
                   result[`upper${key}`].push({ time: candle.time, value: vwap + mult * stdev });
                   result[`lower${key}`].push({ time: candle.time, value: vwap - mult * stdev });
               }
           }
       }

       return result;
   }

// ---------------------------------------------------------------------------
// computeIndicatorRaw(canonicalKey, candles) — dispatches a canonical cache
// key to the right calculator call, with the exact same options-building
// logic already used inline in index.html's chart rendering, so a key
// computed here and a key computed there are byte-identical.
// ---------------------------------------------------------------------------
function computeIndicatorRaw(key, candles) {
    const parts = key.split("_");
    const kind = parts[0];

    if (kind === "ema" || kind === "sma") {
        const length = parseInt(parts[1], 10);
        const source = parts.slice(2).join("_") || "close";
        return kind === "ema" ? calculateEMA(candles, length, source) : calculateSMA(candles, length, source);
    }
    if (kind === "supertrend") {
        return calculateSupertrend(candles, { atrLength: parseInt(parts[1], 10), factor: parseFloat(parts[2]) });
    }
    if (kind === "afh") {
        return calculateHighestHighResistance(candles, { length: parseInt(parts[1], 10) });
    }
    if (kind === "pivottrendline") {
        // pivottrendline_<length>_<high|low>
        const length = parseInt(parts[1], 10);
        const mode = parts[2];
        return calculateTrendlinePoints(candles, length, mode);
    }
    if (kind === "rsi") {
        if (parts[1] === "sma") {
            // rsi_sma_<length>_<source>_<smoothingType>_<smoothingLength>
            const length = parseInt(parts[2], 10);
            const source = parts[3];
            const smoothingType = parts[4];
            const smoothingLength = parseInt(parts[5], 10);
            const baseKey = `rsi_${length}_${source}_${smoothingType}_${smoothingLength}`;
            const rsiData = computeIndicatorRaw(baseKey, candles);
            return smoothingType === "ema"
                ? calculateEMA(rsiData, smoothingLength, "value")
                : calculateSMA(rsiData, smoothingLength, "value");
        }
        // rsi_<length>_<source>_<smoothingType>_<smoothingLength>
        const length = parseInt(parts[1], 10);
        const source = parts[2];
        const smoothingType = parts[3];
        const smoothingLength = parseInt(parts[4], 10);
        return calculateRSI(candles, { length, source, smoothingType, smoothingLength });
    }
    if (kind === "macd") {
        // macd_<source>_<fastLength>_<slowLength>_<signalLength>_<oscMaType>_<signalMaType>
        const source = parts[1];
        const fastLength = parseInt(parts[2], 10);
        const slowLength = parseInt(parts[3], 10);
        const signalLength = parseInt(parts[4], 10);
        const oscMaType = parts[5];
        const signalMaType = parts[6];
        return calculateMACD(candles, { source, fastLength, slowLength, signalLength, oscMaType, signalMaType });
    }
    throw new Error(`computeIndicatorRaw: unknown canonical key "${key}"`);
}

// ---------------------------------------------------------------------------
// extractQuerySeries(canonicalKey, subfield, raw) — turns whatever shape is
// cached under a canonical key into a plain number[] the query engine can
// index with [0]/[1]/etc. This is the ONLY place that knows about the
// ".subfield" convention (line/signal/hist for macd, a/b for pivottrendline).
// ---------------------------------------------------------------------------
function extractQuerySeries(canonicalKey, subfield, raw) {
    if (raw == null) return undefined;
    const kind = canonicalKey.split("_")[0];

    if (kind === "afh") {
        // single-point indicator: represented as a one-element array so
        // key[0] resolves and key[1]+ correctly falls out of range.
        return typeof raw.price === "number" ? [raw.price] : [];
    }

    if (kind === "pivottrendline") {
        const line = subfield === "a" ? raw.lineA : subfield === "b" ? raw.lineB : null;
        if (!line || !line.length) return [];
        // Last point is always extrapolated out to the latest bar (see
        // calculateTrendlinePoints) — that's the "current" value at index 0.
        const latestVal = line[line.length - 1].value;
        return typeof latestVal === "number" ? [latestVal] : [];
    }

    if (kind === "macd") {
        const seriesKey = subfield === "signal" ? "signalLine" : subfield === "hist" ? "histogram" : "macdLine";
        const series = raw[seriesKey];
        return Array.isArray(series) ? series.map((p) => (typeof p.value === "number" ? p.value : undefined)) : [];
    }

    // ema / sma / supertrend / rsi / rsi_sma: raw is already an array of
    // {time, value, ...}, full history, index-aligned with the candles.
    if (Array.isArray(raw)) return raw.map((p) => (typeof p.value === "number" ? p.value : undefined));

    return undefined;
}

// Given the list of CANONICAL keys the worker computed, produce the list of
// QUERY-SYNTAX field names to show as pills (expanding object-shaped
// indicators into their queryable subfields).
function deriveQueryFieldsFromCanonicalKeys(canonicalKeys) {
    const fields = [];
    canonicalKeys.forEach((key) => {
        const kind = key.split("_")[0];
        if (kind === "macd") fields.push(`${key}.line`, `${key}.signal`, `${key}.hist`);
        else if (kind === "pivottrendline") fields.push(`${key}.a`, `${key}.b`);
        else fields.push(key);
    });
    return fields;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        getSourceValue, calculateSMA, calculateEMA, calculateMACD, calculateRSI,
        calculateSupertrend, calculateHighestHighResistance, calculateTrendlinePoints,
        computeIndicatorRaw, extractQuerySeries, deriveQueryFieldsFromCanonicalKeys,
    };
} else if (typeof self !== "undefined") {
    self.IndicatorCalculators = {
        getSourceValue, calculateSMA, calculateEMA, calculateMACD, calculateRSI,
        calculateSupertrend, calculateHighestHighResistance, calculateTrendlinePoints,
        computeIndicatorRaw, extractQuerySeries, deriveQueryFieldsFromCanonicalKeys,
    };
}
