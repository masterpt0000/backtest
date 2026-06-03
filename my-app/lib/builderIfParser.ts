/**
 * Uma linha tipo ``rsi > 30 and ema[1] > ema or rsi < 50``.
 * ``ind[k]`` = valor do indicador k velas atrás (k = 0 vela actual).
 */
import type { BollingerBand, BuilderLogicExpr, BuilderOp, BuilderOperand } from "@/lib/chartBuilderSpec";
import { builderDeltaRef } from "@/lib/builderDeltaRef";
import type { StrategyIndicator } from "@/lib/strategies";

type Tok =
  | { k: "num"; v: number; pos: number }
  | { k: "id"; v: string; pos: number }
  | { k: "op"; v: ">=" | "<=" | "==" | ">" | "<"; pos: number }
  | { k: "and"; pos: number }
  | { k: "or"; pos: number }
  | { k: "(" | ")" | "[" | "]" | ","; pos: number };

function tokenize(source: string): Tok[] | { error: string } {
  const s = source.trim();
  const out: Tok[] = [];
  let i = 0;
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  while (true) {
    skipWs();
    if (i >= s.length) break;
    const pos = i;
    const c = s[i]!;
    if (c === "(" || c === ")" || c === "[" || c === "]") {
      out.push({ k: c, pos });
      i++;
      continue;
    }
    if (c === ",") {
      out.push({ k: ",", pos });
      i++;
      continue;
    }
    if (c === ">" && s[i + 1] === "=") {
      out.push({ k: "op", v: ">=", pos });
      i += 2;
      continue;
    }
    if (c === "<" && s[i + 1] === "=") {
      out.push({ k: "op", v: "<=", pos });
      i += 2;
      continue;
    }
    if (c === "=" && s[i + 1] === "=") {
      out.push({ k: "op", v: "==", pos });
      i += 2;
      continue;
    }
    if (c === ">") {
      out.push({ k: "op", v: ">", pos });
      i++;
      continue;
    }
    if (c === "<") {
      out.push({ k: "op", v: "<", pos });
      i++;
      continue;
    }
    if (c === "=") {
      out.push({ k: "op", v: "==", pos });
      i++;
      continue;
    }
    if (/\d/.test(c) || (c === "-" && /\d/.test(s[i + 1] ?? ""))) {
      let j = i;
      if (s[j] === "-") j++;
      while (j < s.length && /\d/.test(s[j]!)) j++;
      if (s[j] === "." && /\d/.test(s[j + 1] ?? "")) {
        j++;
        while (j < s.length && /\d/.test(s[j]!)) j++;
      }
      const raw = s.slice(i, j);
      const v = Number(raw);
      if (!Number.isFinite(v)) return { error: `número inválido em ${pos}` };
      out.push({ k: "num", v, pos });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[a-zA-Z0-9_.]/.test(s[j]!)) j++;
      const word = s.slice(i, j);
      const low = word.toLowerCase();
      if (low === "and") out.push({ k: "and", pos });
      else if (low === "or") out.push({ k: "or", pos });
      else out.push({ k: "id", v: word, pos });
      i = j;
      continue;
    }
    return { error: `carácter inesperado '${c}' na posição ${pos}` };
  }
  return out;
}

type ResolvedInd = { ref: string; bollingerBand?: BollingerBand };

function talibByFunction(indicators: StrategyIndicator[], talibName: string): StrategyIndicator[] {
  const u = talibName.trim().toUpperCase();
  return indicators.filter(
    (x) =>
      x.kind === "talib" &&
      (x.params?.talibFunction?.trim().toUpperCase() ?? "") === u,
  );
}

function mergeUniqueById(list: StrategyIndicator[]): StrategyIndicator[] {
  const m = new Map<string, StrategyIndicator>();
  for (const x of list) m.set(x.id, x);
  return [...m.values()];
}

function indicatorTimePeriod(ind: StrategyIndicator): number | null {
  const tp = ind.params?.talibParams?.timeperiod ?? ind.params?.period;
  if (typeof tp !== "number" || !Number.isFinite(tp)) return null;
  return Math.round(tp);
}

function talibAliasToFunction(alias: string): string | null {
  const a = alias.toLowerCase();
  if (a === "rsi") return "RSI";
  if (a === "ema") return "EMA";
  if (a === "bb" || a === "bollinger" || a === "bbands") return "BBANDS";
  return null;
}

function resolveDeltaIndicatorName(name: string, indicators: StrategyIndicator[]): ResolvedInd | { error: string } | null {
  const raw = name.trim();
  const low = raw.toLowerCase();
  if (!low.endsWith("_delta")) return null;

  const baseRaw = raw.slice(0, -"_delta".length);
  const baseLow = baseRaw.toLowerCase();
  const byId = indicators.find((x) => x.id.toLowerCase() === baseLow);
  if (byId) return { ref: builderDeltaRef(byId.id) };

  const withPeriod = /^([a-zA-Z_]+)(\d+)$/.exec(baseRaw);
  if (withPeriod) {
    const fn = talibAliasToFunction(withPeriod[1]!);
    const wantedPeriod = Number(withPeriod[2]);
    if (fn && Number.isFinite(wantedPeriod)) {
      const cand = talibByFunction(indicators, fn).filter((x) => indicatorTimePeriod(x) === wantedPeriod);
      if (cand.length === 1) return { ref: builderDeltaRef(cand[0]!.id) };
      if (cand.length > 1) {
        return {
          error: `vários ${withPeriod[1]}${wantedPeriod}: usa o id exacto (${cand
            .map((c) => `${c.id}_delta`)
            .join(", ")})`,
        };
      }
    }
  }

  const fn = talibAliasToFunction(baseRaw);
  if (fn) {
    const cand = talibByFunction(indicators, fn);
    if (cand.length === 1) return { ref: builderDeltaRef(cand[0]!.id) };
    if (cand.length > 1) {
      return {
        error: `vários ${baseRaw}: usa o id exacto (${cand.map((c) => `${c.id}_delta`).join(", ")})`,
      };
    }
  }

  return { error: `indicador delta desconhecido: ${raw}` };
}

function resolveIndicatorName(name: string, indicators: StrategyIndicator[]): ResolvedInd | { error: string } {
  const raw = name.trim();
  if (!raw) return { error: "identificador vazio" };
  const lowFile = raw.toLowerCase();
  const byId = indicators.find((x) => x.id.toLowerCase() === lowFile);
  if (byId) {
    return { ref: byId.id };
  }
  /** Preço fecho da vela (não é indicador; sem conflito com id próprio porque ``byId`` vem primeiro). */
  if (lowFile === "close" || lowFile === "c") {
    return { ref: "close" };
  }
  /** Séries derivadas das tabelas fact (Liquidations/OI…) — mesmo contrato que o FastAPI feat_*. */
  if (/^feat_[a-z][a-z0-9_]*$/i.test(raw)) {
    return { ref: raw.toLowerCase().trim() };
  }
  const delta = resolveDeltaIndicatorName(raw, indicators);
  if (delta) return delta;
  const dot = raw.indexOf(".");
  if (dot >= 0) {
    const base = raw.slice(0, dot).toLowerCase();
    const band = raw.slice(dot + 1).toLowerCase();
    if (!["upper", "mid", "lower"].includes(band)) {
      return { error: `banda Bollinger inválida: ${raw}` };
    }
    const bbKind = base === "bb" || base === "bollinger";
    if (!bbKind) {
      const indDot = indicators.find((x) => x.id.toLowerCase() === base);
      if (
        indDot?.kind === "talib" &&
        (indDot.params?.talibFunction ?? "").trim().toUpperCase() === "BBANDS"
      ) {
        return { ref: indDot.id, bollingerBand: band as BollingerBand };
      }
      return { error: `banda só em BBANDS TA-Lib (ex.: t2.upper se o id for t2); verifica o id — ${raw}` };
    }
    const cand = indicators.filter(
      (x) =>
        x.kind === "talib" && (x.params?.talibFunction ?? "").trim().toUpperCase() === "BBANDS",
    );
    if (cand.length === 0) return { error: "não há indicador Bollinger na estratégia" };
    if (cand.length > 1) {
      return {
        error: `vários Bollinger: usa o id (ex. ${cand[0]!.id}.upper) em vez de bb.${band}`,
      };
    }
    return { ref: cand[0]!.id, bollingerBand: band as BollingerBand };
  }

  // Legado: nomes tipo "rsi1" quando o único RSI é TA-Lib com id "t1"
  if (/^rsi\d+$/i.test(raw)) {
    const rsiTalib = talibByFunction(indicators, "RSI");
    if (rsiTalib.length === 1) return { ref: rsiTalib[0]!.id };
    if (rsiTalib.length > 1) {
      return {
        error: `vários RSI: usa o id exacto (${rsiTalib.map((c) => c.id).join(", ")}) em vez de ${raw}`,
      };
    }
  }

  const kindAlias = lowFile === "bb" || lowFile === "bollinger" ? "bbands" : lowFile;
  if (kindAlias === "rsi" || kindAlias === "ema" || kindAlias === "bbands") {
    let cand: StrategyIndicator[];
    if (kindAlias === "bbands") {
      cand = indicators.filter(
        (x) =>
          x.kind === "talib" && (x.params?.talibFunction ?? "").trim().toUpperCase() === "BBANDS",
      );
    } else if (kindAlias === "rsi") {
      cand = mergeUniqueById([...talibByFunction(indicators, "RSI")]);
    } else {
      cand = mergeUniqueById([...talibByFunction(indicators, "EMA")]);
    }
    if (cand.length === 0) return { error: `não há indicador ${kindAlias} na estratégia` };
    if (cand.length > 1) {
      return {
        error: `vários ${kindAlias}: usa o id exacto (${cand.map((c) => c.id).join(", ")})`,
      };
    }
    const ref = cand[0]!;
    if (kindAlias === "bbands") return { ref: ref.id, bollingerBand: "mid" };
    return { ref: ref.id };
  }
  return { error: `indicador desconhecido: ${raw}` };
}

function toOperand(r: ResolvedInd, shift: number): BuilderOperand & { type: "indicator" } {
  return {
    type: "indicator",
    ref: r.ref,
    ...(r.bollingerBand ? { bollingerBand: r.bollingerBand } : {}),
    ...(shift > 0 ? { shift } : {}),
  };
}

function mapRelOp(v: ">=" | "<=" | "==" | ">" | "<"): BuilderOp {
  if (v === ">=") return "ge";
  if (v === "<=") return "le";
  if (v === "==") return "eq";
  if (v === ">") return "gt";
  return "lt";
}

class Parser {
  private ix = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly indicators: StrategyIndicator[],
    private readonly errors: string[],
  ) {}

  private peek(): Tok | undefined {
    return this.toks[this.ix];
  }

  private eatParen(closing: ")" | "]"): boolean {
    const t = this.peek();
    if (!t || t.k !== closing) return false;
    this.ix++;
    return true;
  }

  parseExpr(): BuilderLogicExpr | null {
    const e = this.parseOr();
    if (!e) return null;
    if (this.peek() !== undefined) {
      const t = this.peek()!;
      this.errors.push(`token inesperado após expressão (pos. ${t.pos})`);
      return null;
    }
    return e;
  }

  private parseOr(): BuilderLogicExpr | null {
    let left = this.parseAnd();
    if (!left) return null;
    while (this.peek()?.k === "or") {
      this.ix++;
      const right = this.parseAnd();
      if (!right) return null;
      left = { kind: "any", children: [left, right] };
    }
    return left;
  }

  private parseAnd(): BuilderLogicExpr | null {
    let left = this.parseAtom();
    if (!left) return null;
    while (this.peek()?.k === "and") {
      this.ix++;
      const right = this.parseAtom();
      if (!right) return null;
      left = { kind: "all", children: [left, right] };
    }
    return left;
  }

  private parseAtom(): BuilderLogicExpr | null {
    const t = this.peek();
    if (t?.k === "(") {
      this.ix++;
      const inner = this.parseOr();
      if (!inner) return null;
      if (!this.eatParen(")")) {
        this.errors.push("falta ')'");
        return null;
      }
      return inner;
    }
    return this.parseComparison();
  }

  private parseComparison(): BuilderLogicExpr | null {
    const leftOp = this.parseOperand();
    if (!leftOp) return null;
    const opTok = this.peek();
    if (!opTok || opTok.k !== "op") {
      this.errors.push("esperava operador (>, <, >=, <=, ==) após operando");
      return null;
    }
    this.ix++;
    const rop = mapRelOp(opTok.v);
    const rightOp = this.parseOperand();
    if (!rightOp) return null;
    return {
      kind: "atom",
      condition: { left: leftOp, right: rightOp, op: rop },
    };
  }

  private parseOperand(): BuilderOperand | null {
    const t = this.peek();
    if (!t) {
      this.errors.push("expressão incompleta");
      return null;
    }
    if (t.k === "num") {
      this.ix++;
      return { type: "constant", value: t.v };
    }
    if (t.k === "id" && t.v.toLowerCase() === "entry") {
      return this.parseEntrySnapOperand();
    }
    if (t.k !== "id") {
      this.errors.push(`operando inválido na posição ${t.pos}`);
      return null;
    }
    this.ix++;
    const resolved = resolveIndicatorName(t.v, this.indicators);
    if ("error" in resolved) {
      this.errors.push(resolved.error);
      return null;
    }
    let shift = 0;
    if (this.peek()?.k === "[") {
      this.ix++;
      const num = this.peek();
      if (!num || num.k !== "num" || !Number.isFinite(num.v) || num.v < 0) {
        this.errors.push("esperava número ≥ 0 em [ ] após indicador");
        return null;
      }
      if (!Number.isInteger(num.v)) {
        this.errors.push("deslocamento [n] tem de ser inteiro");
        return null;
      }
      this.ix++;
      if (!this.eatParen("]")) {
        this.errors.push("falta ']' após deslocamento");
        return null;
      }
      shift = num.v;
    }
    return toOperand(resolved, shift);
  }

  /** ``entry(id)`` ou ``entry(id, delta)`` — valor(es) memorizado(s) na entrada da posição. */
  private parseEntrySnapOperand(): BuilderOperand | null {
    const t0 = this.peek();
    if (!t0 || t0.k !== "id" || t0.v.toLowerCase() !== "entry") {
      this.errors.push("operando entry esperado");
      return null;
    }
    this.ix++;
    const open = this.peek();
    if (!open || open.k !== "(") {
      this.errors.push("entry esperava '('");
      return null;
    }
    this.ix++;
    const innerTok = this.peek();
    if (!innerTok || innerTok.k !== "id") {
      this.errors.push("entry esperava identificador de indicador");
      return null;
    }
    this.ix++;
    const resolved = resolveIndicatorName(innerTok.v, this.indicators);
    if ("error" in resolved) {
      this.errors.push(resolved.error);
      return null;
    }
    let add: number | undefined;
    if (this.peek()?.k === ",") {
      this.ix++;
      const numTok = this.peek();
      if (!numTok || numTok.k !== "num" || !Number.isFinite(numTok.v)) {
        this.errors.push("entry: esperava número após ','");
        return null;
      }
      add = numTok.v;
      this.ix++;
    }
    if (!this.eatParen(")")) {
      this.errors.push("entry: falta ')'");
      return null;
    }
    const snap: BuilderOperand = {
      type: "entry_snap",
      ref: resolved.ref,
      ...(resolved.bollingerBand ? { bollingerBand: resolved.bollingerBand } : {}),
    };
    if (add !== undefined) return { type: "adjusted", inner: snap, add };
    return snap;
  }
}

export function parseBuilderIfLine(
  source: string,
  indicators: StrategyIndicator[],
): { ok: true; expr: BuilderLogicExpr } | { ok: false; errors: string[] } {
  const toks = tokenize(source);
  if ("error" in toks) return { ok: false, errors: [toks.error] };
  if (toks.length === 0) return { ok: false, errors: ["expressão vazia"] };
  const errors: string[] = [];
  const p = new Parser(toks, indicators, errors);
  const expr = p.parseExpr();
  if (!expr || errors.length) return { ok: false, errors: errors.length ? errors : ["expressão inválida"] };
  return { ok: true, expr };
}
